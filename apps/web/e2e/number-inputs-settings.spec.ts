import { expect, test, type Page } from '@playwright/test';
import { ChangeRequestDto, PricingTierSet, ProductAdminDto, SubmitChangeResult, type PricingTierInput } from '@los/contracts';
import { guardConsole, MockApi, type MockRequest } from './mock-api';

// F9-2: /settings/products ба /settings/pricing-ийн тоон оролтууд. antd InputNumber нь "5сая"→5, LTV 70→1.00, хүү 300→100, "-5"→5 гэж чимээгүй засдаг байсан.
// Одоо бичсэн текст хэвээр үлдэж, буруу бол талбарт алдаа гарч, серверт юу ч явахгүй. Бутархай талбарууд (LTV, шимтгэл, haircut…) форм дээр ХУВИАР, API-д бутархай.
const AT = '2026-11-20T03:00:00.000Z';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';
const NOT_MONEY = 'Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)';
const NOT_NUMBER = 'Зөвхөн тоо оруулна уу (жишээ: 12)';

// ── Бүтээгдэхүүн ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const PRODUCT = ProductAdminDto.parse({
  id: PRODUCT_ID, code: 'CONSUMER', productType: 'CONSUMER', currency: 'MNT', isActive: true, name: 'Хэрэглээний зээл',
  minAmount: 100_000, maxAmount: 5_000_000, minTerm: 3, maxTerm: 24, minRate: 24, maxRate: 36, defaultFeeRate: 0.01, requiresCollateral: true,
  maxLtv: 0.25, maxDti: 0.55, minDscr: 1.25, calcWeightThreshold: null, contractTemplateId: null, documentChecklist: null, collateralChecklist: null,
  haircut: { VEHICLE: 0.7 }, externalValuationThreshold: null, costOfGoodsRate: null, applicationCount: 0, updatedAt: AT, updatedBy: null,
});

const pendingResult = (action: string, payload: unknown) => SubmitChangeResult.parse({
  outcome: 'PENDING',
  request: ChangeRequestDto.parse({
    id: '11111111-1111-4111-8111-111111111111', orgId: 'org-1', branchId: null, targetType: 'PRODUCT', targetId: PRODUCT_ID, action, applicationId: null, mode: 'FOUR_EYES', status: 'PENDING',
    payload, before: null, baseVersion: null, reason: 'тест', makerId: '22222222-2222-4222-8222-222222222222', makerRoles: ['ADMIN'], requiredCheckerRoles: ['ADMIN'],
    checkerId: null, checkerRoles: [], checkerComment: null, failureReason: null, expiresAt: '2026-11-23T03:00:00.000Z', decidedAt: null, createdAt: AT, updatedAt: AT,
  }),
});

async function setupProducts(page: Page) {
  const api = new MockApi('ADMIN');
  api.get('/products', { json: [PRODUCT] });
  api.get('/maker-checker/requests', { json: { items: [], total: 0, page: 1, pageSize: 20 } });
  api.post('/products', ({ body }) => ({ status: 202, json: pendingResult('CREATE', body) }));
  api.put('/products/:id', ({ body }) => ({ status: 202, json: pendingResult('UPDATE', body) }));
  await api.install(page);
  guardConsole(page);
  return api;
}

const field = (page: Page, id: string) => page.locator(`#${id}`);
const submit = (page: Page) => page.getByRole('button', { name: 'Батлуулахаар илгээх' });
const productBody = (req: MockRequest) => (req.body as { product: Record<string, unknown> }).product;

async function openCreate(page: Page): Promise<MockApi> {
  const api = await setupProducts(page);
  await page.goto('/settings/products');
  await page.getByRole('button', { name: 'Бүтээгдэхүүн нэмэх' }).first().click();
  await expect(field(page, 'code')).toBeVisible();
  return api;
}

/** Зөв үндсэн утгуудыг бөглөнө; `over`-оор талбар тус бүрийг (id → текст) дарна. */
async function fillProduct(page: Page, over: Record<string, string> = {}) {
  const values: Record<string, string> = {
    code: 'SME_PLUS', productType: 'BUSINESS', name: 'ЖДҮ+', minAmount: '1000000', maxAmount: '50000000', minTerm: '3', maxTerm: '36', minRate: '20', maxRate: '38', ...over,
  };
  for (const [id, text] of Object.entries(values)) await field(page, id).fill(text);
  await page.getByPlaceholder('Хамгийн багадаа 3 тэмдэгт — батлагчид харагдана').fill('Шинэ бүтээгдэхүүн');
}

test.describe('F9-2: бүтээгдэхүүний тоон оролт', () => {
  test('LTV "70", шимтгэл "1.5", haircut "70", дүн "5сая" нь хэрэглэгчийн хүссэнээр хадгалагдана (LTV 1.00 болж clamp хийхгүй)', async ({ page }) => {
    const api = await openCreate(page);
    await fillProduct(page, { maxAmount: '5сая', defaultFeeRate: '1.5', maxLtv: '70', maxDti: '55', minDscr: '1.25', haircut_VEHICLE: '70' });
    await submit(page).click();
    await expect.poll(() => api.callsTo('POST', '/products').length).toBe(1);
    expect(productBody(api.callsTo('POST', '/products')[0]!)).toMatchObject({
      minAmount: 1_000_000, maxAmount: 5_000_000, minTerm: 3, maxTerm: 36, minRate: 20, maxRate: 38,
      defaultFeeRate: 0.015, maxLtv: 0.7, maxDti: 0.55, minDscr: 1.25, haircut: { VEHICLE: 0.7 },
    });
  });

  test('хүү "300" ба LTV "150" нь талбарт алдаа гаргана, clamp хийхгүй; юу ч илгээгдэхгүй', async ({ page }) => {
    const api = await openCreate(page);
    await fillProduct(page, { maxRate: '300', maxLtv: '150' });
    await submit(page).click();
    await expect(page.getByText('Дээд хүү 0–100% хооронд байх ёстой')).toBeVisible();
    await expect(page.getByText('LTV дээд 0–100% хооронд байх ёстой')).toBeVisible();
    await expect(page.getByText('Улаанаар тэмдэглэсэн талбаруудыг засна уу')).toBeVisible(); // доод талд (товчны дэргэд) нэгтгэсэн мэдэгдэл
    await expect(field(page, 'maxRate')).toHaveValue('300'); // бичсэн нь хэвээр
    expect(api.callsTo('POST', '/products')).toHaveLength(0);
  });

  test('"-5", "тав" зэрэг дүн нь тодорхой алдаа; "5сая" нь хугацаанд 5 болохгүй', async ({ page }) => {
    const api = await openCreate(page);
    await fillProduct(page, { minAmount: '-5', maxAmount: 'тав', minTerm: '5сая', maxTerm: '700' });
    await submit(page).click();
    await expect(page.getByText('Сөрөг дүн оруулах боломжгүй')).toBeVisible();
    await expect(page.getByText(NOT_MONEY)).toBeVisible();
    await expect(page.getByText(NOT_NUMBER)).toBeVisible();
    await expect(page.getByText('Дээд хугацаа 1–600 хооронд байх ёстой')).toBeVisible();
    expect(api.callsTo('POST', '/products')).toHaveLength(0);
  });

  test('заавал талбар хоосон бол чимээгүй 0 болгохгүй, "оруулна уу" гэнэ', async ({ page }) => {
    const api = await openCreate(page);
    await fillProduct(page, { minAmount: '', minTerm: '' });
    await submit(page).click();
    await expect(page.getByText('Доод дүн оруулна уу')).toBeVisible();
    await expect(page.getByText('Доод хугацаа оруулна уу')).toBeVisible();
    expect(api.callsTo('POST', '/products')).toHaveLength(0);
  });

  test('засахад хадгалсан бутархай (0.25, 0.55, 0.01, haircut 0.7) хувиар харагдаж, өөрчлөхгүй хадгалахад ижил бутархай явна', async ({ page }) => {
    const api = await setupProducts(page);
    await page.goto('/settings/products');
    await page.getByRole('row', { name: /CONSUMER/ }).getByRole('button', { name: 'Засах' }).click();
    await expect(field(page, 'maxLtv')).toHaveValue('25');
    await expect(field(page, 'maxDti')).toHaveValue('55');
    await expect(field(page, 'defaultFeeRate')).toHaveValue('1');
    await expect(field(page, 'minDscr')).toHaveValue('1.25');
    await expect(field(page, 'haircut_VEHICLE')).toHaveValue('70');
    await expect(field(page, 'minAmount')).toHaveValue('100,000');
    await page.getByPlaceholder('Хамгийн багадаа 3 тэмдэгт — батлагчид харагдана').fill('Хүүг шинэчилсэн');
    await submit(page).click();
    await expect.poll(() => api.callsTo('PUT', '/products/:id').length).toBe(1);
    expect(productBody(api.callsTo('PUT', '/products/:id')[0]!)).toMatchObject({ minAmount: 100_000, maxLtv: 0.25, maxDti: 0.55, defaultFeeRate: 0.01, minDscr: 1.25, haircut: { VEHICLE: 0.7 } });
  });
});

// ── Үнэлгээний шатлал ─────────────────────────────────────────────────────────────────────────────────────────────────────
const TIERS: PricingTierInput[] = [
  { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650, interestRate: 22, feeRate: 0.015, isDefault: false },
  { code: 'C', name: 'Дундаж', band: 'YELLOW', minScore: 0, interestRate: 28, feeRate: 0.02, isDefault: true },
];
const TIER_PATH = '/loan-terms/pricing/tiers';

async function setupPricing(page: Page) {
  const api = new MockApi('ADMIN');
  const set = (tiers: PricingTierInput[]) => PricingTierSet.parse({ scope: 'DEFAULT', productId: null, version: 1, tiers, updatedAt: AT, updatedBy: null });
  api.get('/products', { json: [] });
  api.get(TIER_PATH, { json: set(TIERS) });
  api.put(TIER_PATH, ({ body }) => ({ json: set((body as { tiers: PricingTierInput[] }).tiers) }));
  await api.install(page);
  guardConsole(page);
  await page.goto('/settings/pricing');
  await expect(page.getByTestId('tier-0-rate')).toBeVisible();
  return api;
}

const tierInput = (page: Page, i: number, f: 'score' | 'rate' | 'fee') => page.getByTestId(`tier-${i}-${f}`);
const tierError = (page: Page, i: number, f: 'score' | 'rate' | 'fee') => page.getByTestId(`tier-${i}-${f}-error`);
const saveTiers = (page: Page) => page.getByRole('button', { name: 'Хадгалах', exact: true });
const tierPuts = (api: MockApi) => api.callsTo('PUT', TIER_PATH);

test.describe('F9-2: үнэлгээний шатлалын тоон оролт', () => {
  test('шимтгэл хувиар харагдана (0.015 → 1.5); "2.5" бичвэл бутархай 0.025 хадгалагдана', async ({ page }) => {
    const api = await setupPricing(page);
    await expect(tierInput(page, 0, 'fee')).toHaveValue('1.5');
    await tierInput(page, 0, 'fee').fill('2.5');
    await saveTiers(page).click();
    await expect.poll(() => tierPuts(api).length).toBe(1);
    expect((tierPuts(api)[0]!.body as { tiers: PricingTierInput[] }).tiers[0]).toMatchObject({ code: 'B', minScore: 650, interestRate: 22, feeRate: 0.025 });
  });

  test('хүү "300" нь талбарт алдаа гаргана (100 болгож clamp хийхгүй), хадгалагдахгүй', async ({ page }) => {
    const api = await setupPricing(page);
    await tierInput(page, 0, 'rate').fill('300');
    await expect(tierError(page, 0, 'rate')).toHaveText('Хүү 0–100% хооронд байх ёстой');
    await expect(tierInput(page, 0, 'rate')).toHaveValue('300');
    await saveTiers(page).click();
    expect(tierPuts(api)).toHaveLength(0);
  });

  test('шимтгэл "150" нь 1.00 болж clamp хийгдэхгүй, алдаа гарна', async ({ page }) => {
    const api = await setupPricing(page);
    await tierInput(page, 1, 'fee').fill('150');
    await expect(tierError(page, 1, 'fee')).toHaveText('Шимтгэл 0–100% хооронд байх ёстой');
    await saveTiers(page).click();
    expect(tierPuts(api)).toHaveLength(0);
  });

  test('оноо "5сая" нь 5 болохгүй (тоо биш), хоосон нь 0 болохгүй (заавал); хадгалагдахгүй', async ({ page }) => {
    const api = await setupPricing(page);
    await tierInput(page, 0, 'score').fill('5сая');
    await expect(tierError(page, 0, 'score')).toHaveText(NOT_NUMBER);
    await tierInput(page, 1, 'score').fill('');
    await expect(tierError(page, 1, 'score')).toHaveText('Доод оноо оруулна уу');
    await saveTiers(page).click();
    expect(tierPuts(api)).toHaveLength(0);
  });
});
