import { expect, test, type Page } from '@playwright/test';
import { ChangeRequestDto, ProductAdminDto, SubmitChangeResult } from '@los/contracts';
import { MockApi } from './mock-api';

// ══ G2 · F9-3: /settings/products — бүтээгдэхүүний форм ══════════════════════════════════════════════════════════════════════
const P_AT = '2026-11-20T03:00:00.000Z';
const P_ID = '44444444-4444-4444-8444-444444444444';
const P_PRODUCT = ProductAdminDto.parse({
  id: P_ID, code: 'CONSUMER', productType: 'CONSUMER', currency: 'MNT', isActive: true, name: 'Хэрэглээний зээл',
  minAmount: 100_000, maxAmount: 5_000_000, minTerm: 3, maxTerm: 24, minRate: 24, maxRate: 36, defaultFeeRate: 0.01, requiresCollateral: false,
  maxLtv: null, maxDti: null, minDscr: null, calcWeightThreshold: null, contractTemplateId: null, documentChecklist: null, collateralChecklist: null,
  haircut: null, externalValuationThreshold: null, costOfGoodsRate: null, applicationCount: 0, updatedAt: P_AT, updatedBy: null,
});
const pPending = (action: string, payload: unknown) => SubmitChangeResult.parse({
  outcome: 'PENDING',
  request: ChangeRequestDto.parse({
    id: '11111111-1111-4111-8111-111111111111', orgId: 'org-1', branchId: null, targetType: 'PRODUCT', targetId: P_ID, action, applicationId: null, mode: 'FOUR_EYES', status: 'PENDING',
    payload, before: null, baseVersion: null, reason: 'тест', makerId: '22222222-2222-4222-8222-222222222222', makerRoles: ['ADMIN'], requiredCheckerRoles: ['ADMIN'],
    checkerId: null, checkerRoles: [], checkerComment: null, failureReason: null, expiresAt: '2026-11-23T03:00:00.000Z', decidedAt: null, createdAt: P_AT, updatedAt: P_AT,
  }),
});

async function setupProducts(page: Page): Promise<MockApi> {
  const api = new MockApi('ADMIN');
  api.get('/products', { json: [P_PRODUCT] });
  api.get('/maker-checker/requests', { json: { items: [], total: 0, page: 1, pageSize: 20 } });
  api.post('/products', ({ body }) => ({ status: 202, json: pPending('CREATE', body) }));
  api.put('/products/:id', ({ body }) => ({ status: 202, json: pPending('UPDATE', body) }));
  await api.install(page);
  return api;
}

const pItem = (page: Page, id: string) => page.locator('.ant-form-item', { has: page.locator(`#${id}`) });
const pSubmit = (page: Page) => page.getByRole('button', { name: 'Батлуулахаар илгээх' });
const pReason = (page: Page) => page.getByPlaceholder('Хамгийн багадаа 3 тэмдэгт — батлагчид харагдана');
const ENGLISH_ZOD = /UPPER_SNAKE_CASE|String must contain|Number must be|Required|minTerm:|name:|code:/;

async function openProductCreate(page: Page): Promise<MockApi> {
  const api = await setupProducts(page);
  await page.goto('/settings/products');
  await page.getByRole('button', { name: 'Бүтээгдэхүүн нэмэх' }).first().click();
  await expect(page.locator('#code')).toBeVisible();
  return api;
}

test.describe('G2 · бүтээгдэхүүний форм: талбар бүрт Монгол алдаа (F9-3)', () => {
  const CODE_FORMAT = 'Код: зөвхөн ТОМ латин үсэг, тоо, _ (жишээ: SME_PLUS). Эхний тэмдэгт үсэг, 2–32 тэмдэгт; кирилл, жижиг үсэг, зай болохгүй';

  test('findings-ийн оролт: хоосон нэр, хугацаа 0, кирилл код, хоосон төрөл → бүгд НЭГЭН ЗЭРЭГ, талбар бүр дээр Монголоор; англи zod/түлхүүр харагдахгүй', async ({ page }) => {
    const api = await openProductCreate(page);
    await page.locator('#code').fill('Хэрэглээний зээл 2');
    await page.locator('#minTerm').fill('0');
    await pReason(page).fill('Шинэ бүтээгдэхүүн');
    await pSubmit(page).click();

    await expect(pItem(page, 'code').getByText(CODE_FORMAT)).toBeVisible();
    await expect(pItem(page, 'productType').getByText('Бүтээгдэхүүний төрлийг оруулна уу (жишээ: BUSINESS)')).toBeVisible();
    await expect(pItem(page, 'name').getByText('Бүтээгдэхүүний нэрийг оруулна уу')).toBeVisible();
    await expect(pItem(page, 'minTerm').getByText('Доод хугацаа 1–600 хооронд байх ёстой')).toBeVisible();
    await expect(pItem(page, 'minAmount').getByText('Доод дүн оруулна уу')).toBeVisible();
    await expect(page.getByText('Улаанаар тэмдэглэсэн талбаруудыг засна уу')).toBeVisible();
    await expect(page.getByText(ENGLISH_ZOD)).toHaveCount(0);
    expect(api.callsTo('POST', '/products')).toEqual([]);
  });

  test('код, төрлийн формат заавар (жишээтэй) илгээхээс өмнө харагдана', async ({ page }) => {
    await openProductCreate(page);
    await expect(pItem(page, 'code')).toContainText('ТОМ латин үсэг, тоо, _ (жишээ: SME_PLUS)');
    await expect(pItem(page, 'productType')).toContainText('ТОМ латин үсэг, тоо, _ (жишээ: BUSINESS)');
  });

  test('жижиг үсэгтэй код "sme_plus" чимээгүй засагдахгүй — ТОМ үсэг гэж заана; зөв утгаар серверт явна', async ({ page }) => {
    const api = await openProductCreate(page);
    const values: Record<string, string> = { code: 'sme_plus', productType: 'BUSINESS', name: 'ЖДҮ+', minAmount: '1000000', maxAmount: '50000000', minTerm: '3', maxTerm: '36', minRate: '20', maxRate: '38' };
    for (const [id, text] of Object.entries(values)) await page.locator(`#${id}`).fill(text);
    await pReason(page).fill('Шинэ бүтээгдэхүүн');
    await pSubmit(page).click();
    await expect(pItem(page, 'code').getByText(CODE_FORMAT)).toBeVisible();
    await expect(page.locator('#code')).toHaveValue('sme_plus');
    expect(api.callsTo('POST', '/products')).toEqual([]);

    await page.locator('#code').fill('SME_PLUS');
    await expect(pItem(page, 'code').getByText(CODE_FORMAT)).toHaveCount(0);
    await pSubmit(page).click();
    await expect.poll(() => api.callsTo('POST', '/products').length).toBe(1);
    expect((api.callsTo('POST', '/products')[0]!.body as { product: Record<string, unknown> }).product).toMatchObject({ code: 'SME_PLUS', productType: 'BUSINESS', name: 'ЖДҮ+', minTerm: 3, maxTerm: 36 });
  });

  test('засахад код/төрөл (өөрчлөгдөхгүй) шалгагдахгүй; нэрийг хоослоход зөвхөн нэрийн талбарт алдаа', async ({ page }) => {
    const api = await setupProducts(page);
    await page.goto('/settings/products');
    await page.getByRole('row', { name: /CONSUMER/ }).getByRole('button', { name: 'Засах' }).click();
    await expect(page.locator('#code')).toBeDisabled();
    await page.locator('#name').fill('');
    await pReason(page).fill('Нэр засах');
    await pSubmit(page).click();
    await expect(pItem(page, 'name').getByText('Бүтээгдэхүүний нэрийг оруулна уу')).toBeVisible();
    await expect(pItem(page, 'code').locator('.ant-form-item-explain-error')).toHaveCount(0);
    await expect(pItem(page, 'productType').locator('.ant-form-item-explain-error')).toHaveCount(0);
    expect(api.callsTo('PUT', '/products/:id')).toEqual([]);
  });
});
