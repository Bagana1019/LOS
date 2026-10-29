import { expect, test, type Locator, type Page } from '@playwright/test';
import { GateIssueCode, type CollateralView, type UserRole } from '@los/contracts';
import { IDS, makeApartment, makeChecklist, makeCollateral, makeEncumbrance, makeGate, makeIssue, makeList, makeOwnership, makeValuation } from '../src/features/collateral/collateral.fixtures';
import { collateralId, installCollateralApi, newWorld, type World } from './collateral-mock';
import { expectClean, expectNoHorizontalScroll } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Барьцааны алхам (`/los/loan-application/:id/collateral`): нэмэх, шалгалт, үнэлгээ, G0 жагсаалт, баримт, ЭБ. Backend-гүй: origination-ийн дуудлагуудыг e2e/collateral-mock.ts дууриана.
// UI тооцоолол хийдэггүй тул mock "сервер" санаатайгаар UI-ийн тооцохоос өөр дүн (100,000₮-д бөөрөнхийлсөн) буцаана.

const PAGE = `/los/loan-application/${IDS.app}/collateral`;
const COLLATERALS = '/applications/:aid/collaterals';

async function setup(page: Page, overrides: Partial<World> = {}, role: UserRole = 'OFFICER') {
  const api = new MockApi(role);
  const world = installCollateralApi(api, newWorld(overrides));
  await api.install(page);
  const guard = guardConsole(page);
  return { api, world, guard };
}

/** antd Select-ээс сонголт хийнэ (label-аар олно). */
async function choose(page: Page, scope: Locator, label: string, option: string) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: option }).first().click();
}

const issueRow = (page: Page, code: string) => page.locator(`[data-testid="gate-issue"][data-code="${code}"]`);
const card = (page: Page) => page.getByTestId('collateral-card');

/**
 * Табыг сонгоно. Нарийн дэлгэц дээр antd Tabs «overflow» горимд табын жагсаалтаа (transform) гүйлгэдэг тул
 * Playwright-ийн scrollIntoView-тэй давхцвал mousedown/mouseup өөр элемент дээр буугаад click алдагдах тохиолдол бий —
 * сонгогдтол дахин дарна (бодит хэрэглэгчийн товшилтод scrollIntoView байхгүй).
 */
async function selectTab(drawer: Locator, name: string) {
  const tab = drawer.getByRole('tab', { name });
  await expect(async () => {
    await tab.click({ timeout: 2_000 });
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

async function openDetails(page: Page, tab?: string) {
  await card(page).first().getByRole('button', { name: /^Дэлгэрэнгүй/ }).click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer).toBeVisible();
  if (tab) await selectTab(drawer, tab);
  return drawer;
}

const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 DEMO') });

const doc = (id: string, key: string, name: string) => ({ id, checklistKey: key, fileId: IDS.file, fileName: name, mime: 'application/pdf', size: 2048, note: null, uploadedBy: 'officer.a', uploadedAt: '2026-10-29T03:00:00.000Z' });

/** G0 бүрэн хангагдсан барьцаа (баримт, өмчлөл, ачаалал, үнэлгээ бүгд). */
const completeVehicle = (overrides: Partial<CollateralView> = {}): CollateralView =>
  makeCollateral({
    ownership: makeOwnership(),
    encumbrance: makeEncumbrance(),
    valuation: makeValuation(),
    checklist: makeChecklist([{ key: 'vehicle_certificate', label: 'Тээврийн хэрэгслийн гэрчилгээ', satisfied: true, documents: [doc('d1', 'vehicle_certificate', 'certificate.pdf')] }, { key: 'insurance', label: 'Даатгалын гэрээ', required: false }]),
    ...overrides,
  });

test.describe('Барьцаа нэмэх (FR-6.1)', () => {
  test('автомашин: форм шалгагдаж, зөв хүсэлт илгээгдэж, жагсаалт ба G0 шинэчлэгдэнэ', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);

    // Хоосон: G0 «барьцаа бүртгээгүй»
    await expect(page.getByText('Барьцаа бүртгэгдээгүй байна')).toBeVisible();
    await expect(issueRow(page, 'NO_COLLATERAL')).toContainText('Барьцаа бүртгээгүй байна');
    await expect(page.getByTestId('gate-status')).toHaveText('G0 дутуу (1)');

    await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });
    await expect(modal).toBeVisible();
    // Өмчлөгч: үндсэн зээлдэгч урьдчилан сонгогдсон; «Харилцагч» алхам руу холбоос
    await expect(modal.getByText('Бат Болд · УБ******78 · Үндсэн зээлдэгч')).toBeVisible();
    await expect(modal.getByRole('link', { name: /Харилцагч» алхамд барьцаалагчаар бүртгэнэ үү/ })).toHaveAttribute('href', `/los/loan-application/${IDS.app}/client`);

    await choose(page, modal, 'Хөрөнгийн төрөл', 'Тээврийн хэрэгсэл');
    // Буруу дугаар, дутуу талбар → сервер рүү явахгүй, талбар дээр монгол алдаа
    await modal.getByLabel('Улсын дугаар').fill('abc');
    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal.getByText(/Улсын дугаар 4 цифр, 2–3 кирилл үсэгтэй байна/)).toBeVisible();
    await expect(modal.getByText('Заавал бөглөнө').first()).toBeVisible();
    expect(api.callsTo('POST', COLLATERALS)).toHaveLength(0);

    await modal.getByLabel('Улсын дугаар').fill('1234УБА');
    await modal.getByLabel('Үйлдвэрлэгч (марк)').fill('Toyota');
    await modal.getByLabel('Загвар').fill('Prius');
    await modal.getByLabel('Үйлдвэрлэсэн он').fill('2012');
    await modal.getByRole('button', { name: 'Нэмэх' }).click();

    await expect(modal).toBeHidden();
    expect(api.callsTo('POST', COLLATERALS)).toHaveLength(1);
    expect(api.lastCall('POST', COLLATERALS)?.body).toMatchObject({
      assetType: 'VEHICLE',
      ownerCustomerId: IDS.owner,
      source: 'MANUAL',
      description: { plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012 },
    });

    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toContainText('Toyota Prius · 2012 он · 1234УБА');
    await expect(card(page)).toContainText('Өмчлөгч: Бат Болд (Үндсэн зээлдэгч)');
    // Шинэ барьцаа бүх шалгалтаар дутуу: G0 жагсаалт шинэчлэгдэв
    await expect(issueRow(page, 'NO_COLLATERAL')).toHaveCount(0);
    for (const code of ['OWNERSHIP_NOT_CHECKED', 'ENCUMBRANCE_NOT_CHECKED', 'CHECKLIST_INCOMPLETE', 'NOT_VALUED']) await expect(issueRow(page, code)).toHaveCount(1);
    await expect(page.getByTestId('gate-status')).toHaveText('G0 дутуу (4)');
    expectClean(guard, api);
  });

  test('ХУР-аас сонгох: форм бөглөгдөж, xypRef-тэй илгээгдэнэ; барьцаалагдсан нь сонгогдохгүй', async ({ page }) => {
    const { api, guard } = await setup(page, {
      xypAssets: [
        { xypRef: 'xyp-veh-1', assetType: 'VEHICLE', label: 'Toyota Prius 1234УБА', description: { plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012 }, alreadyPledged: false },
        { xypRef: 'xyp-veh-2', assetType: 'VEHICLE', label: 'Nissan Note 5678УНА', description: { plateNo: '5678УНА', make: 'Nissan', model: 'Note', manufactureYear: 2015 }, alreadyPledged: true },
      ],
    });
    await page.goto(PAGE);
    await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });

    await modal.getByRole('button', { name: 'ХУР-аас сонгох' }).click();
    const picker = modal.getByTestId('xyp-picker');
    await expect(picker).toContainText('Toyota Prius 1234УБА');
    await expect(picker).toContainText('DEMO: ХУР-ын холболт');
    await expect(picker.getByRole('button', { name: 'Сонгох: Nissan Note 5678УНА' })).toBeDisabled();
    expect(api.lastCall('GET', `${COLLATERALS}/xyp-assets`)?.search.get('ownerCustomerId')).toBe(IDS.owner);

    await picker.getByRole('button', { name: 'Сонгох: Toyota Prius 1234УБА' }).click();
    await expect(picker).toBeHidden();
    await expect(modal.getByText('ХУР-аас: Toyota Prius 1234УБА')).toBeVisible();
    await expect(modal.getByLabel('Улсын дугаар')).toHaveValue('1234УБА');
    await expect(modal.getByLabel('Загвар')).toHaveValue('Prius');

    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal).toBeHidden();
    expect(api.lastCall('POST', COLLATERALS)?.body).toMatchObject({ assetType: 'VEHICLE', source: 'XYP', xypRef: 'xyp-veh-1', description: { plateNo: '1234УБА' } });
    expectClean(guard, api);
  });

  test('үл хөдлөх: дугаар аль нэг нь заавал (гэрээний монгол мессеж)', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);
    await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });
    await choose(page, modal, 'Хөрөнгийн төрөл', 'Орон сууц');
    await modal.getByLabel('Аймаг, хот').fill('Улаанбаатар');
    await modal.getByLabel('Сум, дүүрэг').fill('Хан-Уул');
    await modal.getByLabel('Талбай').fill('56.5');
    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal.getByText(/Үл хөдлөх хөрөнгийн дугаар/).first()).toBeVisible();
    expect(api.callsTo('POST', COLLATERALS)).toHaveLength(0);

    await modal.getByLabel('Өмчлөх эрхийн дугаар (ХУР)').fill('Ү-2201001234');
    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal).toBeHidden();
    expect(api.lastCall('POST', COLLATERALS)?.body).toMatchObject({ assetType: 'APARTMENT', description: { propertyId: 'Ү-2201001234', areaM2: 56.5, purpose: 'RESIDENTIAL', address: { province: 'Улаанбаатар', district: 'Хан-Уул' } } });
    await expect(card(page)).toContainText('Хан-Уул · 56.5 м²');
    expectClean(guard, api);
  });

  test('сервер талын алдаа (409 APPLICATION_NOT_EDITABLE) формд мессежтэй гарна', async ({ page }) => {
    const { api, guard, world } = await setup(page);
    await page.goto(PAGE);
    await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });
    await choose(page, modal, 'Хөрөнгийн төрөл', 'Бусад');
    await modal.getByLabel(/^Нэр/).fill('Тавилга');
    world.editable = false; // хүсэлт хооронд төлөв солигдсон (UI-д мэдэгдээгүй)
    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal.getByRole('alert')).toContainText('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө');
    await expect(modal).toBeVisible();
    expectClean(guard, api);
  });

  test('Esc товчоор модал хаагдана', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);
    await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });
    await expect(modal).toBeVisible();
    // Анимаци дуустал фокус модал дотор орно (хүртээмж: гараар удирдах боломж) — тэгээд Esc
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.ant-modal-wrap'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    expectClean(guard, api);
  });
});

test.describe('Шалгалт (FR-6.5, FR-6.6)', () => {
  test('өмчлөл, ачааллыг шалгаж, төлөв жагсаалт ба G0-д шинэчлэгдэнэ', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] });
    await page.goto(PAGE);
    await expect(card(page)).toContainText('Өмчлөл: Шалгаагүй');
    await expect(issueRow(page, 'OWNERSHIP_NOT_CHECKED')).toBeVisible();

    const drawer = await openDetails(page, 'Шалгалт');
    const ownership = drawer.getByTestId('ownership-section');
    const encumbrance = drawer.getByTestId('encumbrance-section');
    await expect(ownership).toContainText('Өмчлөлийг шалгаагүй байна.');

    await ownership.getByTestId('ownership-run').click();
    await expect(ownership).toContainText('Баталгаажсан');
    await expect(ownership).toContainText('Арга: Бүртгэлээс шалгах · Эх сурвалж: ХУР');
    await expect(ownership).toContainText('Оролцогч: Үндсэн зээлдэгч');
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/ownership-check`)?.body).toEqual({ method: 'REGISTRY' });

    await encumbrance.getByTestId('encumbrance-run').click();
    await expect(encumbrance).toContainText('Ачаалалгүй');
    await expect(encumbrance).toContainText('ЗМС (зээлийн мэдээллийн сан)');
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/encumbrance-check`)?.body).toEqual({ method: 'REGISTRY' });

    // Дэвсгэр жагсаалт мөн шинэчлэгдсэн
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(card(page)).toContainText('Өмчлөл: Баталгаажсан');
    await expect(card(page)).toContainText('Ачаалал: Ачаалалгүй');
    await expect(issueRow(page, 'OWNERSHIP_NOT_CHECKED')).toHaveCount(0);
    await expect(issueRow(page, 'ENCUMBRANCE_NOT_CHECKED')).toHaveCount(0);
    expectClean(guard, api);
  });

  test('ачаалалтай хөрөнгө: алдааны тайлбар ба G0 дутагдал', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral({ description: { plateNo: '9999УБА', make: 'Lexus', model: 'LX', manufactureYear: 2018 } })] });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Шалгалт');
    await drawer.getByTestId('encumbrance-run').click();
    const section = drawer.getByTestId('encumbrance-section');
    await expect(section).toContainText('Хөрөнгө ачаалалтай тул барьцаалах боломжгүй.');
    await expect(section).toContainText('Барьцаалуулсан: Жишиг банк');
    await page.keyboard.press('Escape');
    await expect(card(page)).toContainText('Ачаалал: Ачаалалтай');
    await expect(issueRow(page, 'ENCUMBERED')).toContainText('Хөрөнгө ачаалалтай (өөр зээлд барьцаалагдсан)');
    await expect(issueRow(page, 'ENCUMBERED')).toContainText('Асуудалтай');
    expectClean(guard, api);
  });

  test('бүртгэлгүй төрөл (мал): ЗЭЗ баталгаажуулж тайлбар илгээнэ (DECLARED)', async ({ page }) => {
    const livestock = makeCollateral({ id: collateralId(7), assetType: 'LIVESTOCK', description: { livestockType: 'HORSE', ageGroup: 'ADULT', headCount: 120 }, checklist: [] });
    const { api, guard } = await setup(page, { items: [livestock] });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Шалгалт');
    const ownership = drawer.getByTestId('ownership-section');
    await expect(ownership).toContainText('Энэ төрлийн хөрөнгийн бүртгэл байхгүй');
    await ownership.getByLabel('Тайлбар').fill('Малын тоо толгойг багийн дарга баталгаажуулсан');
    await ownership.getByTestId('ownership-run').click();
    await expect.poll(() => api.lastCall('POST', `${COLLATERALS}/:cid/ownership-check`)?.body).toEqual({ method: 'DECLARED', note: 'Малын тоо толгойг багийн дарга баталгаажуулсан' });
    await expect(ownership).toContainText('Тайлбар: Малын тоо толгойг багийн дарга баталгаажуулсан');
    expectClean(guard, api);
  });
});

test.describe('Үнэлгээ (FR-14)', () => {
  test('санал → өөрчилбөл шалтгаан заавал; хадгалсан дүн API-ийнхаар (UI тооцоолохгүй)', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral({ ownership: makeOwnership(), encumbrance: makeEncumbrance() })] });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Үнэлгээ');
    const current = drawer.getByTestId('current-valuation');
    await expect(current).toContainText('Үнэлгээ хийгдээгүй байна.');

    await drawer.getByLabel('Гүйлт').fill('150000');
    await drawer.getByRole('button', { name: 'Системийн санал авах' }).click();
    const panel = drawer.getByTestId('suggestion-panel');
    await expect(panel.getByTestId('suggested-value')).toHaveText('20,000,000₮');
    await expect(panel.getByTestId('haircut-rate')).toHaveText('70%');
    // DEMO тэмдэглэгээ: параметр ба haircut-ийн эх сурвалж батлагдаагүй
    await expect(panel.getByText('DEMO', { exact: true }).first()).toBeVisible();
    await expect(panel).toContainText('DEMO анхдагч утга (батлагдаагүй)');
    await expect(panel).toContainText('DEMO: суурь үнэ, коэффициент, элэгдэл батлагдаагүй туршилтын утга');
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/valuation/suggest`)?.body).toEqual({ mileageKm: 150000 });

    const finalValue = drawer.getByLabel('Зах зээлийн үнэ (эцсийн)');
    await expect(finalValue).toHaveValue('20,000,000'); // санал урьдчилан бөглөгдсөн
    await expect(drawer.getByLabel('Өөрчилсөн шалтгаан')).toHaveCount(0); // саналтай ижил → шалтгаан шаардахгүй

    // Саналаас өөр дүн → шалтгаан талбар гарч, хоосон бол хадгалагдахгүй
    await finalValue.fill('18500000');
    const reason = drawer.getByLabel('Өөрчилсөн шалтгаан');
    await expect(reason).toBeVisible();
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect(drawer.getByText('Системийн саналаас өөр дүн оруулсан тул шалтгааныг заавал бичнэ')).toBeVisible();
    expect(api.callsTo('POST', `${COLLATERALS}/:cid/valuation`)).toHaveLength(0);

    await reason.fill('Будагтай, хуучирсан');
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect.poll(() => api.callsTo('POST', `${COLLATERALS}/:cid/valuation`).length).toBe(1);
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/valuation`)?.body).toEqual({ marketValue: 18_500_000, overrideReason: 'Будагтай, хуучирсан', mileageKm: 150000 });

    // 18,500,000 × 70% = 12,950,000 боловч сервер 100,000₮-д бөөрөнхийлж 12,900,000 буцаасан — UI түүнийг л харуулна
    await expect(current).toContainText('18,500,000₮');
    await expect(current).toContainText('12,900,000₮');
    await expect(current).not.toContainText('12,950,000');
    await expect(current).toContainText('Будагтай, хуучирсан');
    await expect(current).toContainText('Үнэлэгдсэн');

    await page.keyboard.press('Escape');
    await expect(card(page)).toContainText('12,900,000₮');
    await expect(page.getByTestId('summary-collateral-value')).toContainText('12,900,000₮');
    await expect(page.getByTestId('summary-ltv')).toContainText('77.52%'); // 10,000,000 ÷ 12,900,000 — API-ийн LTV
    await expect(page.getByText('LTV хязгаараас хэтэрсэн', { exact: true })).toBeVisible();
    await expect(issueRow(page, 'LTV_EXCEEDED')).toBeVisible();
    expectClean(guard, api);
  });

  test('саналыг өөрчлөхгүй хадгалбал marketValue илгээхгүй (сервер өөрийн саналыг хэрэглэнэ)', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Үнэлгээ');
    await drawer.getByRole('button', { name: 'Системийн санал авах' }).click();
    await expect(drawer.getByTestId('suggested-value')).toHaveText('20,000,000₮');
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect.poll(() => api.callsTo('POST', `${COLLATERALS}/:cid/valuation`).length).toBe(1);
    const body = api.lastCall('POST', `${COLLATERALS}/:cid/valuation`)?.body;
    expect(body).not.toHaveProperty('marketValue');
    expect(body).not.toHaveProperty('overrideReason');
    expect(body).toEqual({ mileageKm: 150000 }); // бүртгэлд байгаа гүйлт л явна
    await expect(drawer.getByTestId('current-valuation')).toContainText('14,000,000₮');
    expectClean(guard, api);
  });

  test('санал боломжгүй: тайлбар, дүн ба шалтгаан хоёулаа заавал', async ({ page }) => {
    const { api, guard } = await setup(page, {
      items: [makeCollateral()],
      suggestion: {
        assetType: 'VEHICLE',
        suggestion: { available: false, method: null, marketValue: null, lowValue: null, highValue: null, confidence: null, basis: {}, warnings: [], unavailableReason: 'NO_BASE_PRICE' },
        haircut: { rate: 0.7, source: 'PRODUCT_RULE' },
        manualValueRequired: false,
        externalValuationThreshold: null,
      },
    });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Үнэлгээ');
    await drawer.getByRole('button', { name: 'Системийн санал авах' }).click();
    await expect(drawer.getByTestId('suggestion-panel')).toContainText('Энэ хөрөнгөд суурь үнэ олдсонгүй');
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect(drawer.getByText('Зах зээлийн үнийг оруулна уу')).toBeVisible();

    await drawer.getByLabel('Зах зээлийн үнэ (эцсийн)').fill('9000000');
    await expect(drawer.getByLabel('Өөрчилсөн шалтгаан')).toBeVisible();
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect(drawer.getByText('Системийн саналаас өөр дүн оруулсан тул шалтгааныг заавал бичнэ')).toBeVisible();
    expect(api.callsTo('POST', `${COLLATERALS}/:cid/valuation`)).toHaveLength(0);
    expectClean(guard, api);
  });

  test('шалтгаан хэт богино (< 3 тэмдэгт) бол хадгалагдахгүй', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Үнэлгээ');
    await drawer.getByRole('button', { name: 'Системийн санал авах' }).click();
    await drawer.getByLabel('Зах зээлийн үнэ (эцсийн)').fill('19000000');
    await drawer.getByLabel('Өөрчилсөн шалтгаан').fill('а');
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect(drawer.getByText('Хамгийн багадаа 3 тэмдэгт байна')).toBeVisible();
    expect(api.callsTo('POST', `${COLLATERALS}/:cid/valuation`)).toHaveLength(0);
    expectClean(guard, api);
  });

  test('бараа (гараар оруулдаг төрөл): дүн заавал, шалтгаан шаардахгүй', async ({ page }) => {
    const inventory = makeCollateral({ id: collateralId(9), assetType: 'INVENTORY', description: { name: 'Хүнсний бараа', stocktakeValue: 8_000_000, stocktakeDate: '2026-10-20' }, checklist: [] });
    const { api, guard } = await setup(page, {
      items: [inventory],
      suggestion: {
        assetType: 'INVENTORY',
        suggestion: { available: false, method: null, marketValue: null, lowValue: null, highValue: null, confidence: null, basis: {}, warnings: [], unavailableReason: 'MANUAL_VALUE_ASSET' },
        haircut: { rate: 0.5, source: 'PRODUCT_JSON' },
        manualValueRequired: true,
        externalValuationThreshold: null,
      },
    });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'Үнэлгээ');
    await expect(drawer.getByText('Энэ төрлийн хөрөнгийн үнийг систем санал болгохгүй')).toBeVisible();
    await drawer.getByLabel('Зах зээлийн үнэ (эцсийн)').fill('8000000');
    await expect(drawer.getByLabel('Өөрчилсөн шалтгаан')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' }).click();
    await expect.poll(() => api.callsTo('POST', `${COLLATERALS}/:cid/valuation`).length).toBe(1);
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/valuation`)?.body).toEqual({ marketValue: 8_000_000 });
    expectClean(guard, api);
  });

  test('гадны үнэлгээ: тайлангийн файл заавал; хадгалахад файлын id илгээгдэнэ', async ({ page }) => {
    const { api, guard } = await setup(page, {
      items: [makeCollateral({ ownership: makeOwnership(), encumbrance: makeEncumbrance(), valuation: makeValuation({ externalRequired: true, externalSatisfied: false, marketValue: 150_000_000, collateralValue: 105_000_000 }) })],
    });
    await page.goto(PAGE);
    await expect(card(page)).toContainText('Үнэлгээ: Гадны үнэлгээ шаардлагатай');
    await expect(issueRow(page, 'EXTERNAL_VALUATION_REQUIRED')).toBeVisible();

    const drawer = await openDetails(page, 'Үнэлгээ');
    const form = drawer.getByTestId('external-valuation'); // шаардлагатай үед задарсан байна
    await expect(form).toBeVisible();
    await expect(form.getByText('гадны лицензтэй үнэлгээчний үнэлгээ заавал')).toBeVisible();
    await form.getByLabel('Үнэлгээчин (байгууллага, хүн)').fill('Үнэлгээ ХХК');
    await form.getByLabel('Үнэлсэн огноо').fill('2026-10-20');
    await form.getByLabel('Зах зээлийн үнэ').fill('150000000');
    await form.getByRole('button', { name: 'Гадны үнэлгээ хадгалах' }).click();
    await expect(form.getByText('Үнэлгээний тайлангийн файлыг оруулна уу')).toBeVisible();
    expect(api.callsTo('POST', `${COLLATERALS}/:cid/valuation/external`)).toHaveLength(0);

    await form.locator('input[type=file]').setInputFiles(pdf('report.pdf'));
    await expect(form.getByTestId('external-report-name')).toContainText('report.pdf');
    await form.getByRole('button', { name: 'Гадны үнэлгээ хадгалах' }).click();
    await expect.poll(() => api.callsTo('POST', `${COLLATERALS}/:cid/valuation/external`).length).toBe(1);
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/valuation/external`)?.body).toMatchObject({ appraiser: 'Үнэлгээ ХХК', valuedAt: '2026-10-20', marketValue: 150_000_000, reportFileId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await expect(drawer.getByTestId('current-valuation')).toContainText('Гадны лицензтэй');
    expectClean(guard, api);
  });
});

test.describe('G0 жагсаалт ба LTV (FR-14.4)', () => {
  test('шалтгаан бүр монгол гарчиг, зөвлөмжтэй; «Нээх» нь зөв таб руу, алхмын холбоос зөв хаяг руу', async ({ page }) => {
    const { api, guard, world } = await setup(page, { items: [makeCollateral(), makeApartment()] });
    const issues = GateIssueCode.map((code) => makeIssue(code, ['PRODUCT_MISSING', 'LOAN_AMOUNT_MISSING', 'NO_COLLATERAL', 'LTV_EXCEEDED'].includes(code) ? null : IDS.vehicle, `API: ${code}`));
    // Бүх 17 код нэг дор (сервер ийм хариу өгч магадгүй): жагсаалтын endpoint-ыг дарна
    api.get(COLLATERALS, () => ({ json: makeList(world.items, { gate: makeGate({ issues }), summary: { count: 2, totalMarketValue: 0, totalCollateralValue: 0, loanAmount: null, ltv: null, ltvLimit: 0.7, ltvPass: null, requiresCollateral: true } }) }));
    await page.goto(PAGE);

    await expect(page.getByTestId('gate-status')).toHaveText(`G0 дутуу (${GateIssueCode.length})`);
    await expect(page.getByTestId('gate-issue')).toHaveCount(GateIssueCode.length);
    const list = page.getByTestId('gate-issues');
    // i18n түлхүүр өөрөө (орчуулаагүй) гарч болохгүй
    await expect(list).not.toContainText('collateral.issue.');
    await expect(issueRow(page, 'LTV_EXCEEDED')).toContainText('LTV дээд хязгаараас хэтэрсэн');
    await expect(issueRow(page, 'LTV_EXCEEDED')).toContainText('API: LTV_EXCEEDED'); // API-ийн тодорхой мессеж тодруулга болж харагдана
    await expect(issueRow(page, 'LTV_EXCEEDED')).toContainText('Зээлийн дүнг багасгах эсвэл нэмэлт барьцаа бүртгэнэ үү.');
    await expect(issueRow(page, 'ENCUMBERED')).toContainText('Асуудалтай');
    await expect(issueRow(page, 'NOT_VALUED')).toContainText('Дутуу');
    await expect(issueRow(page, 'NOT_VALUED')).toContainText('Тээврийн хэрэгсэл: Toyota Prius · 2012 он · 1234УБА');

    // Алхам руу очих холбоосууд
    await expect(issueRow(page, 'LOAN_AMOUNT_MISSING').getByRole('link')).toHaveAttribute('href', `/los/loan-application/${IDS.app}/loan`);
    await expect(issueRow(page, 'PRODUCT_MISSING').getByRole('link')).toHaveAttribute('href', `/los/loan-application/${IDS.app}/loan`);
    await expect(issueRow(page, 'OWNER_NOT_ON_APPLICATION').getByRole('link')).toHaveAttribute('href', `/los/loan-application/${IDS.app}/client`);

    // «Нээх» → дутагдалд тохирсон таб
    await issueRow(page, 'NOT_VALUED').getByRole('button', { name: /^Нээх/ }).click();
    const drawer = page.getByRole('dialog').last();
    await expect(drawer.getByRole('tab', { name: 'Үнэлгээ', selected: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await issueRow(page, 'CHECKLIST_INCOMPLETE').getByRole('button', { name: /^Нээх/ }).click();
    await expect(page.getByRole('dialog').last().getByRole('tab', { name: 'Баримт', selected: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // «Барьцаа нэмэх» (NO_COLLATERAL мөр) модал нээнэ
    await issueRow(page, 'NO_COLLATERAL').getByRole('button', { name: 'Барьцаа нэмэх' }).click();
    await expect(page.getByRole('dialog', { name: 'Барьцаа нэмэх' })).toBeVisible();
    expectClean(guard, api);
  });

  test('LTV хязгаарт багтсан: бүх G0 биелсэн, алхам бүрдсэн', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [completeVehicle()], loanAmount: 5_000_000 });
    await page.goto(PAGE);
    await expect(page.getByTestId('summary-market-value')).toContainText('20,000,000₮');
    await expect(page.getByTestId('summary-collateral-value')).toContainText('14,000,000₮');
    await expect(page.getByTestId('summary-loan-amount')).toContainText('5,000,000₮');
    await expect(page.getByTestId('summary-ltv')).toContainText('35.71%');
    await expect(page.getByTestId('summary-ltv')).toContainText('Дээд хязгаар 70%');
    await expect(page.getByText('LTV хязгаарт багтсан', { exact: true })).toBeVisible();
    await expect(page.getByTestId('gate-status')).toHaveText('G0 хангагдсан');
    await expect(page.getByText('G0 хаалт хангагдсан: барьцааны бүх шалгуур биелсэн.')).toBeVisible();
    await expect(page.getByText('Алхам бүрдсэн')).toBeVisible();
    await expect(page.getByTestId('gate-issue')).toHaveCount(0);
    expectClean(guard, api);
  });

  test('LTV хэтэрсэн: улаан шошго, LTV_EXCEEDED дутагдал', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [completeVehicle()], loanAmount: 12_000_000 });
    await page.goto(PAGE);
    await expect(page.getByTestId('summary-ltv')).toContainText('85.71%');
    await expect(page.getByText('LTV хязгаараас хэтэрсэн', { exact: true })).toBeVisible();
    await expect(page.getByTestId('gate-status')).toHaveText('G0 дутуу (1)');
    await expect(issueRow(page, 'LTV_EXCEEDED')).toBeVisible();
    expectClean(guard, api);
  });

  test('барьцаа шаардахгүй бүтээгдэхүүн: G0 алгасагдсан', async ({ page }) => {
    const { api, guard } = await setup(page, { requiresCollateral: false, loanAmount: 3_000_000 });
    await page.goto(PAGE);
    await expect(page.getByText('Барьцаа шаардахгүй', { exact: true })).toBeVisible();
    await expect(page.getByTestId('gate-status')).toHaveText('G0 алгасагдсан');
    await expect(page.getByText('Энэ бүтээгдэхүүн барьцаа шаардахгүй тул G0 хаалт алгасагдсан.')).toBeVisible();
    await expect(page.getByText('Энэ бүтээгдэхүүн барьцаа шаардахгүй тул барьцаагүйгээр үргэлжлүүлж болно.')).toBeVisible();
    expectClean(guard, api);
  });

  test('«G0 дахин тооцох» нь recheck дуудаж жагсаалтыг шинэчилнэ', async ({ page }) => {
    const { api, guard, world } = await setup(page, { items: [completeVehicle()], loanAmount: 5_000_000 });
    await page.goto(PAGE);
    await expect(page.getByTestId('gate-status')).toHaveText('G0 хангагдсан');
    world.loanAmount = 12_000_000; // зээлийн дүн өөр алхамд өөрчлөгдсөн
    await page.getByRole('button', { name: 'G0 дахин тооцох' }).click();
    await expect.poll(() => api.callsTo('POST', `${COLLATERALS}/recheck`).length).toBe(1);
    await expect(page.getByTestId('gate-status')).toHaveText('G0 дутуу (1)');
    await expect(issueRow(page, 'LTV_EXCEEDED')).toBeVisible();
    expectClean(guard, api);
  });
});

test.describe('Баримт, ЭБ, устгах', () => {
  test('барьцааны баримт: dms-д байршуулаад checklist түлхүүрээр холбоно; татах, хасах', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] });
    await page.goto(PAGE);
    await expect(card(page)).toContainText('Баримт: 0 / 1');
    const drawer = await openDetails(page, 'Баримт');
    const row = drawer.locator('[data-testid="collateral-checklist-row"][data-key="vehicle_certificate"]');
    await expect(row).toContainText('Заавал');
    await expect(row).toContainText('Дутуу');
    await expect(row).toContainText('Файл хавсаргаагүй');

    await row.locator('input[type=file]').setInputFiles(pdf('certificate.pdf'));
    await expect(row).toContainText('certificate.pdf');
    await expect(row).toContainText('Хангагдсан');
    // Эхлээд dms, дараа нь барьцаанд холбоно
    const order = api.calls.map((c) => `${c.method} ${c.path}`).filter((p) => p.startsWith('POST /dms/files') || p.endsWith('/documents'));
    expect(order).toEqual(['POST /dms/files', `POST /applications/${IDS.app}/collaterals/${IDS.vehicle}/documents`]);
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/documents`)?.body).toEqual({ checklistKey: 'vehicle_certificate', fileId: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    // Татах: authFetch-ээр blob → хадгалах
    const download = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Татах: certificate.pdf' }).click();
    expect((await download).suggestedFilename()).toBe('certificate.pdf');
    expect(api.callsTo('GET', '/dms/files/:id/content')).toHaveLength(1);

    // Хасах
    await row.getByRole('button', { name: 'Устгах: certificate.pdf' }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Устгах', exact: true }).click();
    await expect(row).toContainText('Файл хавсаргаагүй');
    await expect(row).toContainText('Дутуу');

    // Нэмэлт баримт (зураг)
    const extra = drawer.getByTestId('collateral-extra-docs');
    await extra.locator('input[type=file]').setInputFiles({ name: 'zurag.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await expect(extra).toContainText('zurag.png');
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/documents`)?.body).toMatchObject({ checklistKey: 'other' });
    expectClean(guard, api);
  });

  test('ЭБ бүртгэл: хүсэлтийн төлөв тохирохгүй бол сервер мессеж (409) харагдана; дараа нь амжилттай', async ({ page }) => {
    const { api, guard, world } = await setup(page, { items: [completeVehicle()], registryBlocked: true });
    await page.goto(PAGE);
    const drawer = await openDetails(page, 'ЭБ бүртгэл');
    await drawer.getByLabel('ЭБ-ийн бүртгэлийн дугаар').fill('EB-2026-001');
    await drawer.getByLabel('ЭБ-д бүртгэсэн огноо').fill('2026-10-29');
    await drawer.getByRole('button', { name: 'ЭБ-д бүртгэх' }).click();
    await expect(drawer.getByRole('alert')).toContainText('Хүсэлт батлагдаагүй тул барьцааг ЭБ-д бүртгэх боломжгүй');
    expect(api.lastCall('POST', `${COLLATERALS}/:cid/registry`)?.body).toEqual({ registryNo: 'EB-2026-001', registryDate: '2026-10-29' });

    // Чөлөөлөх: зээл хаагдаагүй → 409 мессеж
    await drawer.getByRole('button', { name: 'Барьцаа чөлөөлөх' }).click();
    await page.locator('.ant-popover button.ant-btn-primary').click();
    await expect(drawer.getByRole('alert').last()).toContainText('Зээл хаагдаагүй тул барьцааг чөлөөлөх боломжгүй');

    world.registryBlocked = false; // хүсэлт батлагдлаа
    await drawer.getByRole('button', { name: 'ЭБ-д бүртгэх' }).click();
    // Тойм ба ЭБ табын самбар хоёулаа DOM-д байдаг тул идэвхтэй самбараар хязгаарлана
    await expect(drawer.getByRole('tabpanel', { name: 'ЭБ бүртгэл' }).getByText('EB-2026-001', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Барьцаа чөлөөлөх' }).click();
    await page.locator('.ant-popover button.ant-btn-primary').click();
    await expect(drawer.getByText(/Барьцааг .* чөлөөлсөн\./)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'ЭБ-д бүртгэх' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(card(page)).toContainText('Чөлөөлсөн');
    expectClean(guard, api);
  });

  test('устгах: баталгаажуулалттай', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] });
    await page.goto(PAGE);
    await card(page).getByRole('button', { name: /^Устгах/ }).click();
    const confirm = page.locator('.ant-popover');
    await expect(confirm).toContainText('Барьцааг устгах уу?');
    await confirm.getByRole('button', { name: 'Болих' }).click();
    expect(api.callsTo('DELETE', `${COLLATERALS}/:cid`)).toHaveLength(0);

    await card(page).getByRole('button', { name: /^Устгах/ }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Устгах', exact: true }).click();
    await expect(card(page)).toHaveCount(0);
    expect(api.callsTo('DELETE', `${COLLATERALS}/:cid`)).toHaveLength(1);
    await expect(page.getByText('Барьцаа бүртгэгдээгүй байна')).toBeVisible();
    await expect(issueRow(page, 'NO_COLLATERAL')).toBeVisible();
    expectClean(guard, api);
  });

  test('засах: зөвхөн өөрчлөгдсөн талбар PATCH-д', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] });
    await page.goto(PAGE);
    const drawer = await openDetails(page);
    await drawer.getByRole('button', { name: 'Засах' }).click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа засах' });
    await expect(modal.getByText('өмчлөл, ачааллын шалгалт болон үнэлгээ хүчингүй болж')).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Хөрөнгийн төрөл' })).toBeDisabled();
    await modal.getByLabel('Тэмдэглэл').fill('Шинэ тэмдэглэл');
    await modal.getByRole('button', { name: 'Хадгалах' }).click();
    await expect(modal).toBeHidden();
    expect(api.lastCall('PATCH', `${COLLATERALS}/:cid`)?.body).toEqual({ note: 'Шинэ тэмдэглэл' });
    expectClean(guard, api);
  });
});

test.describe('Эрх ба төлөв', () => {
  test('хүсэлт засах боломжгүй төлөвт: нэмэх, шалгах, устгах хаалттай; мэдээлэл харагдана', async ({ page }) => {
    const { api, guard } = await setup(page, { editable: false, items: [makeCollateral()] });
    await page.goto(PAGE);
    await expect(page.getByText('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт биш тул барьцааг өөрчлөх боломжгүй.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Барьцаа нэмэх' }).first()).toBeDisabled();
    await expect(card(page).getByRole('button', { name: /^Устгах/ })).toBeDisabled();
    const drawer = await openDetails(page, 'Шалгалт');
    await expect(drawer.getByTestId('ownership-run')).toBeDisabled();
    await expect(drawer.getByTestId('encumbrance-run')).toBeDisabled();
    await selectTab(drawer, 'Баримт');
    await expect(drawer.getByText('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт биш тул өөрчлөх боломжгүй.')).toBeVisible();
    // Үнэлгээ, ЭБ нь дүрээр л хаагддаг (бусад төлөвт зөвшөөрөгдөнө) — сервер төлвөөр шийднэ
    await selectTab(drawer, 'Үнэлгээ');
    await expect(drawer.getByRole('button', { name: 'Системийн санал авах' })).toBeEnabled();
    expectClean(guard, api);
  });

  test('бичих эрхгүй дүр (хянагч): зөвхөн харна', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [makeCollateral()] }, 'APPROVER');
    await page.goto(PAGE);
    await expect(page.getByRole('button', { name: 'Барьцаа нэмэх' }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'G0 дахин тооцох' })).toBeDisabled();
    const drawer = await openDetails(page, 'Үнэлгээ');
    await expect(drawer.getByRole('button', { name: 'Системийн санал авах' })).toBeDisabled();
    await expect(drawer.getByRole('button', { name: 'Үнэлгээ хадгалах' })).toBeDisabled();
    await selectTab(drawer, 'ЭБ бүртгэл');
    await expect(drawer.getByRole('button', { name: 'ЭБ-д бүртгэх' })).toBeDisabled();
    expectClean(guard, api);
  });

  test('жагсаалт ачаалж чадаагүй бол алдаа ба «Дахин ачаалах»', async ({ page }) => {
    const api = new MockApi('OFFICER');
    let fail = true;
    api.get('/applications/:aid/borrowers', () => ({ json: { items: [], summary: { primaryCount: 0, coBorrowerCount: 0, guarantorCount: 0, pledgorCount: 0, clientStepComplete: false, primaryLiabilityShare: null, incomeContributorCustomerIds: [], guaranteeCoverageRatio: null, limits: { maxCoBorrowers: 2, maxGuarantors: 2 }, editable: true }, warnings: [] } }));
    api.get(COLLATERALS, () => (fail ? { status: 500, json: { code: 'INTERNAL', message: 'Internal Server Error' } } : { json: makeList([]) }));
    await api.install(page);
    const guard = guardConsole(page);
    await page.goto(PAGE);
    const alert = page.locator('.ant-alert[role="alert"]');
    await expect(alert).toContainText('Барьцааны мэдээллийг ачаалж чадсангүй');
    await expect(alert).toContainText('Серверийн алдаа гарлаа');
    fail = false;
    await alert.getByRole('button', { name: 'Дахин ачаалах' }).click();
    await expect(page.getByText('Барьцаа бүртгэгдээгүй байна')).toBeVisible();
    expectClean(guard, api);
  });
});

test.describe('Утасны дэлгэц (375px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('жагсаалт, модал, самбар хэвтээ гүйлгэгдэхгүй; интерактив элемент нэртэй, id давхцахгүй', async ({ page }) => {
    const { api, guard } = await setup(page, { items: [completeVehicle(), makeApartment({ owner: { customerId: IDS.owner, displayName: 'Бат Болд', role: 'PRIMARY' } })] });
    await page.goto(PAGE);
    await expect(card(page)).toHaveCount(2);
    await expect(page.getByTestId('summary-ltv')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessibleBasics(page);

    await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
    const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });
    await choose(page, modal, 'Хөрөнгийн төрөл', 'Орон сууц');
    await expect(modal.getByLabel('Талбай')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessibleBasics(page);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    for (const tab of ['Тойм', 'Шалгалт', 'Үнэлгээ', 'Баримт', 'ЭБ бүртгэл']) {
      const drawer = await openDetailsAt(page, tab);
      await expectNoHorizontalScroll(page);
      await expectAccessibleBasics(page);
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
    }
    expectClean(guard, api);
  });
});

async function openDetailsAt(page: Page, tab: string) {
  await card(page).first().getByRole('button', { name: /^Дэлгэрэнгүй/ }).click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer).toBeVisible();
  await selectTab(drawer, tab);
  if (tab === 'Үнэлгээ') await drawer.getByRole('button', { name: 'Системийн санал авах' }).click();
  return drawer;
}

/** Харагдаж буй товч, оролт бүрийн хүртгэлтэй нэр, давхардсан id. */
async function expectAccessibleBasics(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const nameOf = (el: Element): string => {
      const e = el as HTMLElement;
      const aria = e.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelledBy = e.getAttribute('aria-labelledby');
      if (labelledBy && labelledBy.split(/\s+/).map((i) => document.getElementById(i)?.textContent?.trim() ?? '').join('').trim()) return 'labelled';
      if (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim()) return 'label';
      if (e.closest('label')?.textContent?.trim()) return 'label';
      return (e.textContent?.trim() || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
    };
    for (const el of Array.from(document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, [role=combobox], [role=tab], [role=radio]'))) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (!nameOf(el)) out.push(`no accessible name: <${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 60)}">`);
    }
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1 && !id.startsWith('rc_')) out.push(`duplicate id "${id}" x${n}`);
    return out;
  });
  expect(problems, 'accessibility basics').toEqual([]);
}
