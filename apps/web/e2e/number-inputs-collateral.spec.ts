import { expect, test, type Locator, type Page } from '@playwright/test';
import { IDS, makeCollateral, makeEncumbrance, makeOwnership, makeValuation } from '../src/features/collateral/collateral.fixtures';
import { installCollateralApi, newWorld } from './collateral-mock';
import { guardConsole, MockApi } from './mock-api';

// F2-8 (системийн): барьцааны үнэлгээний ₮ талбар. antd InputNumber нь "9сая"→9₮, "-5"→0₮ гэж чимээгүй засдаг байсан — барьцааны үнэ, LTV шууд буруу болно.
// Одоо бичсэн текст хэвээр үлдэж, ойлгогдохгүй/сөрөг бол талбарт алдаа гарч, серверт юу ч явахгүй.
const PAGE = `/los/loan-application/${IDS.app}/collateral`;
const VALUATION = '/applications/:aid/collaterals/:cid/valuation';
const NOT_MONEY = 'Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)';

/** Системийн санал боломжгүй (суурь үнэ олдохгүй) — ЗЭЗ дүн ба шалтгааныг гараар оруулна. */
const NO_SUGGESTION = {
  assetType: 'VEHICLE' as const,
  suggestion: { available: false, method: null, marketValue: null, lowValue: null, highValue: null, confidence: null, basis: {}, warnings: [], unavailableReason: 'NO_BASE_PRICE' as const },
  haircut: { rate: 0.7, source: 'PRODUCT_RULE' as const },
  manualValueRequired: false,
  externalValuationThreshold: null,
};

async function openValuation(page: Page): Promise<{ api: MockApi; drawer: Locator }> {
  const api = new MockApi('OFFICER');
  installCollateralApi(api, newWorld({ items: [makeCollateral({ ownership: makeOwnership(), encumbrance: makeEncumbrance() })], suggestion: NO_SUGGESTION }));
  await api.install(page);
  guardConsole(page);
  await page.goto(PAGE);
  await page.getByTestId('collateral-card').first().getByRole('button', { name: /^Дэлгэрэнгүй/ }).click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer).toBeVisible();
  const tab = drawer.getByRole('tab', { name: 'Үнэлгээ' });
  await expect(async () => {
    await tab.click({ timeout: 2_000 });
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await drawer.getByRole('button', { name: 'Системийн санал авах' }).click();
  await expect(drawer.getByTestId('suggestion-panel')).toContainText('Энэ хөрөнгөд суурь үнэ олдсонгүй');
  return { api, drawer };
}

const save = (drawer: Locator) => drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' });
const finalValue = (drawer: Locator) => drawer.getByLabel('Зах зээлийн үнэ (эцсийн)');
const valuationPosts = (api: MockApi) => api.callsTo('POST', VALUATION);

test.describe('F2-8: барьцааны үнэлгээний дүн', () => {
  test('"9сая" нь 9,000,000₮ болж ойлгогдож хадгалагдана (9₮ биш)', async ({ page }) => {
    const { api, drawer } = await openValuation(page);
    await finalValue(drawer).fill('9сая');
    await finalValue(drawer).blur();
    await expect(finalValue(drawer)).toHaveValue('9,000,000');
    await drawer.getByLabel('Өөрчилсөн шалтгаан').fill('Гараар тогтоосон');
    await save(drawer).click();
    await expect.poll(() => valuationPosts(api).length).toBe(1);
    expect(valuationPosts(api)[0]!.body).toMatchObject({ marketValue: 9_000_000, overrideReason: 'Гараар тогтоосон' });
  });

  test('"-5" нь 0₮ болж хувирахгүй: алдаа гарч, хадгалагдахгүй', async ({ page }) => {
    const { api, drawer } = await openValuation(page);
    await finalValue(drawer).fill('-5');
    await drawer.getByLabel('Өөрчилсөн шалтгаан').fill('Гараар тогтоосон');
    await save(drawer).click();
    await expect(drawer.getByText('Сөрөг дүн оруулах боломжгүй')).toBeVisible();
    await expect(finalValue(drawer)).toHaveValue('-5');
    expect(valuationPosts(api)).toHaveLength(0);
  });

  test('тоо биш текст ("есөн сая") нь чимээгүй устгагдахгүй: алдаа гарна', async ({ page }) => {
    const { api, drawer } = await openValuation(page);
    await finalValue(drawer).fill('есөн сая');
    await save(drawer).click(); // ойлгогдохгүй текстэд "өөрчилсөн шалтгаан" талбар гарахгүй — алдаа түүнээс үл хамаарна
    await expect(drawer.getByText(NOT_MONEY)).toBeVisible();
    await expect(finalValue(drawer)).toHaveValue('есөн сая');
    expect(valuationPosts(api)).toHaveLength(0);
  });

  test('0 дүн ("0") нь хадгалагдахгүй: 0-ээс их байх ёстой', async ({ page }) => {
    const { api, drawer } = await openValuation(page);
    await finalValue(drawer).fill('0');
    await drawer.getByLabel('Өөрчилсөн шалтгаан').fill('Гараар тогтоосон');
    await save(drawer).click();
    await expect(drawer.getByText('Зах зээлийн үнэ 0-ээс их байх ёстой')).toBeVisible();
    expect(valuationPosts(api)).toHaveLength(0);
  });
});

// ── Гадны үнэлгээ ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const EXTERNAL = '/applications/:aid/collaterals/:cid/valuation/external';
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 DEMO') });

async function openExternal(page: Page): Promise<{ api: MockApi; form: Locator }> {
  const api = new MockApi('OFFICER');
  const valuation = makeValuation({ externalRequired: true, externalSatisfied: false, marketValue: 150_000_000, collateralValue: 105_000_000 });
  installCollateralApi(api, newWorld({ items: [makeCollateral({ ownership: makeOwnership(), encumbrance: makeEncumbrance(), valuation })] }));
  await api.install(page);
  guardConsole(page);
  await page.goto(PAGE);
  await page.getByTestId('collateral-card').first().getByRole('button', { name: /^Дэлгэрэнгүй/ }).click();
  const drawer = page.getByRole('dialog').last();
  const tab = drawer.getByRole('tab', { name: 'Үнэлгээ' });
  await expect(async () => {
    await tab.click({ timeout: 2_000 });
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  const form = drawer.getByTestId('external-valuation');
  await expect(form).toBeVisible();
  await form.getByLabel('Үнэлгээчин (байгууллага, хүн)').fill('Үнэлгээ ХХК');
  await form.getByLabel('Үнэлсэн огноо').fill('2026-10-20');
  await form.locator('input[type=file]').setInputFiles(pdf('report.pdf'));
  await expect(form.getByTestId('external-report-name')).toContainText('report.pdf');
  return { api, form };
}

test.describe('F2-8: гадны үнэлгээний дүн', () => {
  test('"150сая" нь 150,000,000₮ болж хадгалагдана (150₮ биш)', async ({ page }) => {
    const { api, form } = await openExternal(page);
    await form.getByLabel('Зах зээлийн үнэ').fill('150сая');
    await form.getByRole('button', { name: 'Гадны үнэлгээ хадгалах' }).click();
    await expect.poll(() => api.callsTo('POST', EXTERNAL).length).toBe(1);
    expect(api.callsTo('POST', EXTERNAL)[0]!.body).toMatchObject({ appraiser: 'Үнэлгээ ХХК', marketValue: 150_000_000 });
  });

  test('"-150" нь эерэг болж хувирахгүй: алдаа гарч, хадгалагдахгүй', async ({ page }) => {
    const { api, form } = await openExternal(page);
    await form.getByLabel('Зах зээлийн үнэ').fill('-150');
    await form.getByRole('button', { name: 'Гадны үнэлгээ хадгалах' }).click();
    await expect(form.getByText('Сөрөг дүн оруулах боломжгүй')).toBeVisible();
    expect(api.callsTo('POST', EXTERNAL)).toHaveLength(0);
  });
});
