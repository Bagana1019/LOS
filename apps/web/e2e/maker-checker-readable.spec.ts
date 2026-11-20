import { expect, test, type Page } from '@playwright/test';
import { BlacklistEntry, ChangeRequestDto, ChangeRequestPage, OrgDirectory, ProductAdminDto } from '@los/contracts';
import { guardConsole, MockApi, type MockReply } from './mock-api';

// Баталгаажуулалт (maker-checker) дэлгэрэнгүй drawer (`/los/maker-checker?tab=inbox&id=…`). Gateway-г mock хийсэн.
// F8-3: шалгагч зөвхөн UUID, `ACTIVATE_BLACK`/`FRAUD_CASE`/`DELINQUENT` код, илгээгчийг UUID-аар харж, "Өмнө → Дараа" бүх талбар "Устгагдсан" байсан.
// F9-5: бүтээгдэхүүний саналын diff англи түлхүүр (`product.maxLtv`), нэгжгүй утга, түүхий UUID-тай; сонин утгад (LTV 100%, доод дүн 5₮) анхааруулга байхгүй байсан.
const REQ_ID = '11111111-1111-4111-8111-111111111111';
const MAKER_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';
const AT = '2026-11-20T03:00:00.000Z';
const URL = `/los/maker-checker?tab=inbox&id=${REQ_ID}`;
const REQUESTS = '/maker-checker/requests';

const PRODUCT_BEFORE = {
  id: PRODUCT_ID, code: 'CONSUMER', productType: 'CONSUMER', currency: 'MNT', isActive: true, name: 'Хэрэглээний зээл',
  minAmount: 100000, maxAmount: 5000000, minTerm: 3, maxTerm: 24, minRate: 24, maxRate: 36, defaultFeeRate: 0.01, requiresCollateral: true,
  maxLtv: 0.25, maxDti: 0.55, minDscr: 1.25, calcWeightThreshold: null, contractTemplateId: null, documentChecklist: null, collateralChecklist: null,
  haircut: null, externalValuationThreshold: null, costOfGoodsRate: null,
};
const { id: _id, code: _code, productType: _type, currency: _cur, isActive: _active, ...PRODUCT_EDITABLE } = PRODUCT_BEFORE;

const makeRequest = (over: Record<string, unknown>): ChangeRequestDto =>
  ChangeRequestDto.parse({
    id: REQ_ID, orgId: 'org-1', branchId: 'br-1', targetType: 'PRODUCT', targetId: PRODUCT_ID, action: 'UPDATE', applicationId: null, mode: 'FOUR_EYES', status: 'PENDING',
    payload: {}, before: null, baseVersion: null, reason: 'Хүүг шинэчлэх шаардлагатай', makerId: MAKER_ID, makerRoles: ['ADMIN'], requiredCheckerRoles: ['ADMIN', 'COMPLIANCE'],
    checkerId: null, checkerRoles: [], checkerComment: null, failureReason: null, expiresAt: '2026-11-23T03:00:00.000Z', decidedAt: null, createdAt: AT, updatedAt: AT,
    history: [{ seq: 1, event: 'SUBMITTED', fromStatus: null, toStatus: 'PENDING', actorId: MAKER_ID, actorRoles: ['ADMIN'], comment: null, data: null, at: AT }],
    canDecide: true, canCancel: false, ...over,
  });

const blacklistRequest = () =>
  makeRequest({
    targetType: 'BLACKLIST_ENTRY', targetId: ENTRY_ID, action: 'ACTIVATE_BLACK', payload: { entryId: ENTRY_ID }, reason: 'Хурлын тогтоолоор',
    before: { entryId: ENTRY_ID, severity: 'GREY', pendingSeverity: 'BLACK', isActive: false, listType: 'DELINQUENT', reasonCode: 'FRAUD_CASE' },
  });

const productUpdate = (product: Record<string, unknown>) =>
  makeRequest({ payload: { id: PRODUCT_ID, product: { ...PRODUCT_EDITABLE, ...product } }, before: PRODUCT_BEFORE });

const productSetActive = () => makeRequest({ action: 'SET_ACTIVE', payload: { id: PRODUCT_ID, isActive: false }, before: { isActive: true } });

const blacklistEntry = BlacklistEntry.parse({
  id: ENTRY_ID, orgId: 'org-1', registerNo: 'УБ12345678', customerType: 'INDIVIDUAL', name: 'Дорж Баатар', listType: 'DELINQUENT', severity: 'GREY', source: 'INTERNAL',
  validUntil: null, deactivationReason: null, pendingSeverity: 'BLACK', reasonCode: 'FRAUD_CASE', reasonText: null, isActive: false, registeredBy: MAKER_ID, registeredAt: AT,
});

const productDto = ProductAdminDto.parse({ ...PRODUCT_BEFORE, applicationCount: 0, updatedAt: AT, updatedBy: null });
const directory = OrgDirectory.parse({ branches: { 'br-1': 'Төв салбар' }, users: { [MAKER_ID]: 'Бат-Эрдэнэ Админ' } });
const forbidden: MockReply = { status: 403, json: { code: 'FORBIDDEN', message: 'Forbidden' } };

interface Lookups { entry?: MockReply; directory?: MockReply; products?: MockReply }

async function setup(page: Page, dto: ChangeRequestDto, lookups: Lookups = {}) {
  const api = new MockApi('ADMIN');
  api.get(`${REQUESTS}/:id`, () => ({ json: dto }));
  api.get(`${REQUESTS}/summary`, { json: { inbox: 1, mine: 0 } });
  api.get(REQUESTS, () => ({ json: ChangeRequestPage.parse({ items: [dto], total: 1, page: 1, pageSize: 20 }) }));
  api.get('/directory', lookups.directory ?? { json: directory });
  api.get('/blacklist/:id', lookups.entry ?? { json: blacklistEntry });
  api.get('/products', lookups.products ?? { json: [productDto] });
  api.post(`${REQUESTS}/:id/approve`, () => ({ json: { ...dto, status: 'APPLIED', canDecide: false } }));
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

const drawer = (page: Page) => page.locator('.ant-drawer');
const modal = (page: Page) => page.locator('.ant-modal');

test.describe('Баталгаажуулалтын drawer: хар жагсаалтын хүсэлт уншигдахуйц (F8-3)', () => {
  test('shows Mongolian labels, the person by name and a before→after — never the raw codes or a bare UUID as the main label', async ({ page }) => {
    const { api, guard } = await setup(page, blacklistRequest());
    await page.goto(URL);
    const d = drawer(page);
    await expect(d.getByTestId('mc-target-name')).toHaveText('Дорж Баатар');
    await expect(d).toContainText('УБ••••5678');
    await expect(d).toContainText('Хар жагсаалтын бүртгэл · Хар болгох');
    await expect(d).toContainText('Залилангийн хэрэг');
    await expect(d).toContainText('Зээлийн хугацаа хэтрэлт');
    await expect(d.getByTestId('mc-maker')).toContainText('Бат-Эрдэнэ Админ');
    await expect(d.getByTestId('mc-maker')).not.toContainText(MAKER_ID);
    await expect(d).not.toContainText('ACTIVATE_BLACK');
    await expect(d).not.toContainText('FRAUD_CASE');
    await expect(d).not.toContainText('DELINQUENT');
    await expect(d.getByTestId('mc-target-id')).toHaveText(ENTRY_ID); // UUID зөвхөн хоёрдогч жижиг текст
    // "Өмнө → Дараа": Түвшин Саарал → Хар, Идэвхтэй Үгүй → Тийм; "Устгагдсан" шошго байхгүй
    const diff = d.getByTestId('mc-diff');
    await expect(diff).toContainText('Түвшин');
    await expect(diff).toContainText('Саарал');
    await expect(diff).toContainText('Хар');
    await expect(diff).toContainText('Идэвхтэй');
    await expect(diff).not.toContainText('Устгагдсан');
    expect(api.unhandled, 'unmocked API calls').toEqual([]);
    expect(guard.problems, 'console problems').toEqual([]);
  });

  test('when the entry and the user directory cannot be loaded the drawer still renders: Mongolian codes, UUIDs only as secondary text', async ({ page }) => {
    await setup(page, blacklistRequest(), { entry: forbidden, directory: forbidden });
    await page.goto(URL);
    const d = drawer(page);
    await expect(d).toContainText('Хар жагсаалтын бүртгэл · Хар болгох');
    await expect(d).toContainText('Залилангийн хэрэг');
    await expect(d.getByTestId('mc-target-id')).toHaveText(ENTRY_ID);
    await expect(d.getByTestId('mc-maker')).toContainText(MAKER_ID);
    await expect(d.getByTestId('mc-diff')).not.toContainText('Устгагдсан');
    await expect(d).not.toContainText('ACTIVATE_BLACK');
  });
});

test.describe('Баталгаажуулалтын drawer: бүтээгдэхүүний санал (F9-5)', () => {
  test('labelled fields with units and a non-blocking warning for an absurd LTV and minimum amount', async ({ page }) => {
    const { api } = await setup(page, productUpdate({ minAmount: 5, maxLtv: 1 }));
    await page.goto(URL);
    const d = drawer(page);
    const diff = d.getByTestId('mc-diff');
    await expect(diff).toContainText('Дээд LTV');
    await expect(diff).toContainText('25%');
    await expect(diff).toContainText('100%');
    await expect(diff).toContainText('Доод дүн');
    await expect(diff).toContainText('100,000₮');
    await expect(diff).toContainText('5₮');
    await expect(d).not.toContainText('product.maxLtv');
    await expect(d).not.toContainText('PRODUCT / UPDATE');
    await expect(d.getByTestId('mc-target-name')).toHaveText('Хэрэглээний зээл');
    const warnings = d.getByTestId('mc-range-warnings');
    await expect(warnings).toContainText('Дээд LTV: 100%');
    await expect(warnings).toContainText('Доод дүн: 5₮');
    // Хориглохгүй: батлах товч идэвхтэй, батлах цонхонд мөн анхааруулга гарч, батлахад хүсэлт явна
    const approve = d.locator('.ant-drawer-footer').getByRole('button', { name: 'Батлах' });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(modal(page).getByTestId('mc-range-warnings')).toContainText('Дээд LTV: 100%');
    await modal(page).getByRole('button', { name: 'Батлах' }).click();
    await expect.poll(() => api.callsTo('POST', `${REQUESTS}/:id/approve`).length).toBe(1);
  });

  test('values inside the sane ranges raise no warning', async ({ page }) => {
    await setup(page, productUpdate({ maxLtv: 0.7, maxRate: 30 }));
    await page.goto(URL);
    const d = drawer(page);
    await expect(d.getByTestId('mc-diff')).toContainText('70%');
    await expect(d.getByTestId('mc-range-warnings')).toHaveCount(0);
  });

  test('activate/deactivate shows the product name and Идэвхтэй Тийм → Үгүй, without "id Нэмэгдсэн" noise or a raw UUID label', async ({ page }) => {
    await setup(page, productSetActive());
    await page.goto(URL);
    const d = drawer(page);
    await expect(d.getByTestId('mc-target-name')).toHaveText('Хэрэглээний зээл');
    await expect(d.getByTestId('mc-target-id')).toHaveText(PRODUCT_ID);
    const diff = d.getByTestId('mc-diff');
    await expect(diff).toContainText('Тийм');
    await expect(diff).toContainText('Үгүй');
    await expect(diff).not.toContainText('Нэмэгдсэн');
    await expect(d).not.toContainText('SET_ACTIVE');
  });
});
