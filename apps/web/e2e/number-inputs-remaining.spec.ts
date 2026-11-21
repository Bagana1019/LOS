import { expect, test, type Locator, type Page } from '@playwright/test';
import { ApprovalLevelDto, ChangeRequestDto, MakerCheckerPolicyDto, SubmitChangeResult } from '@los/contracts';
import { IDS, makeCollateral, makeEncumbrance, makeOwnership } from '../src/features/collateral/collateral.fixtures';
import { installCollateralApi, newWorld } from './collateral-mock';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F2-8 / F9-2 / F9-28 (системийн): antd InputNumber нь "5сая"→5, "-5"→0/1, 0→1, 1000→720 гэж чимээгүй засдаг байсан.
// Үлдсэн талбарууд: батлах түвшний дээд дүн ба SLA, барьцааны форм (он/гүйлт/талбай/₮), үнэлгээний гүйлт, 4 нүдний бодлогын хүчинтэй хугацаа.
// Одоо бичсэн текст хэвээр үлдэж, ойлгогдохгүй/хүрээнээс гарсан бол талбарт алдаа гарч, серверт юу ч явахгүй.
const AT = '2026-11-20T03:00:00.000Z';
const NOT_NUMBER = 'Зөвхөн тоо оруулна уу (жишээ: 12)';
const NOT_MONEY = 'Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)';

const pendingResult = (targetType: string, action: string, payload: unknown) => SubmitChangeResult.parse({
  outcome: 'PENDING',
  request: ChangeRequestDto.parse({
    id: '11111111-1111-4111-8111-111111111111', orgId: 'org-1', branchId: null, targetType, targetId: 'default', action, applicationId: null, mode: 'FOUR_EYES', status: 'PENDING',
    payload, before: null, baseVersion: null, reason: 'тест', makerId: '22222222-2222-4222-8222-222222222222', makerRoles: ['ADMIN'], requiredCheckerRoles: ['ADMIN'],
    checkerId: null, checkerRoles: [], checkerComment: null, failureReason: null, expiresAt: '2026-11-23T03:00:00.000Z', decidedAt: null, createdAt: AT, updatedAt: AT,
  }),
});

// ── Батлах түвшин (/settings/approval-levels) ─────────────────────────────────────────────────────────────────────────────
const LEVELS = [
  ApprovalLevelDto.parse({ id: 'l1', levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: 5_000_000, quorumType: 'MAJORITY', slaHours: 24, members: [{ userId: 'u1' }] }),
  ApprovalLevelDto.parse({ id: 'l2', levelNo: 2, name: 'Төв', amountFrom: 5_000_000, amountTo: null, quorumType: 'MAJORITY', slaHours: 48, members: [{ userId: 'u1' }] }),
];
const LEVELS_PATH = '/approval-levels';

async function openLevels(page: Page) {
  const api = new MockApi('ADMIN');
  api.get(LEVELS_PATH, { json: LEVELS });
  api.get('/admin/users', { json: [] });
  api.get('/maker-checker/requests', { json: { items: [], total: 0, page: 1, pageSize: 20 } });
  api.put(LEVELS_PATH, ({ body }) => ({ status: 202, json: pendingResult('APPROVAL_LEVELS', 'REPLACE', body) }));
  await api.install(page);
  const guard = guardConsole(page);
  await page.goto('/settings/approval-levels');
  await expect(page.getByTestId('level-0-sla')).toBeVisible();
  return { api, guard };
}

const levelInput = (page: Page, i: number, f: 'to' | 'sla') => page.getByTestId(`level-${i}-${f}`);
const levelError = (page: Page, i: number, f: 'to' | 'sla') => page.getByTestId(`level-${i}-${f}-error`);
const submitLevels = (page: Page) => page.getByRole('button', { name: 'Батлуулахаар илгээх' });
const levelPuts = (api: MockApi) => api.callsTo('PUT', LEVELS_PATH);
const putLevels = (api: MockApi) => (levelPuts(api)[0]!.body as { levels: Array<Record<string, unknown>> }).levels;

test.describe('Батлах түвшин: дээд дүн (₮)', () => {
  test('"8сая" нь 8,000,000₮ болж ойлгогдоно (8₮ биш); дараагийн түвшний доод дүн дагаж, хадгалахад ижил дүн явна', async ({ page }) => {
    const { api } = await openLevels(page);
    await levelInput(page, 0, 'to').fill('8сая');
    await levelInput(page, 0, 'to').blur();
    await expect(levelInput(page, 0, 'to')).toHaveValue('8,000,000');
    await expect(page.getByRole('row', { name: /Төв/ })).toContainText('8,000,000');
    await page.locator('textarea').fill('Босго өөрчилсөн');
    await submitLevels(page).click();
    await expect.poll(() => levelPuts(api).length).toBe(1);
    expect(putLevels(api)[0]).toMatchObject({ levelNo: 1, amountFrom: 0, amountTo: 8_000_000, slaHours: 24 });
    expect(putLevels(api)[1]).toMatchObject({ levelNo: 2, amountFrom: 8_000_000, amountTo: null, slaHours: 48 });
  });

  test('"-5" нь эерэг болж хувирахгүй: алдаа гарч, бичсэн текст хэвээр, илгээх товч идэвхгүй', async ({ page }) => {
    const { api } = await openLevels(page);
    await levelInput(page, 0, 'to').fill('-5');
    await expect(levelError(page, 0, 'to')).toHaveText('Сөрөг дүн оруулах боломжгүй');
    await expect(levelInput(page, 0, 'to')).toHaveValue('-5');
    await page.locator('textarea').fill('Босго өөрчилсөн');
    await expect(submitLevels(page)).toBeDisabled();
    expect(levelPuts(api)).toHaveLength(0);
  });

  test('тоо биш текст ("таван сая") чимээгүй устахгүй; хоосон нь 0/хязгааргүй биш — заавал бөглөнө', async ({ page }) => {
    const { api } = await openLevels(page);
    await levelInput(page, 0, 'to').fill('таван сая');
    await expect(levelError(page, 0, 'to')).toHaveText(NOT_MONEY);
    await expect(levelInput(page, 0, 'to')).toHaveValue('таван сая');
    await levelInput(page, 0, 'to').fill('');
    await expect(levelError(page, 0, 'to')).toHaveText('Дээд дүн оруулна уу');
    await expect(submitLevels(page)).toBeDisabled();
    expect(levelPuts(api)).toHaveLength(0);
  });
});

test.describe('Батлах түвшин: SLA (цаг)', () => {
  test('"5сая" нь 5 болохгүй (тоо биш): алдаа, текст хэвээр, илгээх товч идэвхгүй', async ({ page }) => {
    const { api } = await openLevels(page);
    await levelInput(page, 0, 'sla').fill('5сая');
    await expect(levelError(page, 0, 'sla')).toHaveText(NOT_NUMBER);
    await expect(levelInput(page, 0, 'sla')).toHaveValue('5сая');
    await page.locator('textarea').fill('SLA өөрчилсөн');
    await expect(submitLevels(page)).toBeDisabled();
    expect(levelPuts(api)).toHaveLength(0);
  });

  test('0, "-5", 1000 нь 1 / 720 болж clamp хийгдэхгүй: хүрээний алдаа, бичсэн утга хэвээр', async ({ page }) => {
    const { api } = await openLevels(page);
    for (const bad of ['0', '-5', '1000']) {
      await levelInput(page, 0, 'sla').fill(bad);
      await levelInput(page, 0, 'sla').blur();
      await expect(levelError(page, 0, 'sla'), bad).toHaveText('SLA хугацаа 1–720 хооронд байх ёстой');
      await expect(levelInput(page, 0, 'sla'), bad).toHaveValue(bad);
    }
    expect(levelPuts(api)).toHaveLength(0);
  });

  test('хоосон SLA нь чимээгүй 24 болохгүй; "48" зөв бол хадгалагдана', async ({ page }) => {
    const { api } = await openLevels(page);
    await levelInput(page, 0, 'sla').fill('');
    await expect(levelError(page, 0, 'sla')).toHaveText('SLA хугацаа оруулна уу');
    await levelInput(page, 0, 'sla').fill('48');
    await expect(levelError(page, 0, 'sla')).toHaveCount(0);
    await page.locator('textarea').fill('SLA өөрчилсөн');
    await submitLevels(page).click();
    await expect.poll(() => levelPuts(api).length).toBe(1);
    expect(putLevels(api)[0]).toMatchObject({ levelNo: 1, slaHours: 48, amountTo: 5_000_000 });
  });
});

// ── Барьцаа (/los/loan-application/:id/collateral) ────────────────────────────────────────────────────────────────────────
const COLLATERAL_PAGE = `/los/loan-application/${IDS.app}/collateral`;
const COLLATERALS = '/applications/:aid/collaterals';

/** antd Select-ээс сонголт хийнэ (label-аар олно). */
async function choose(page: Page, scope: Locator, label: string, option: string) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: option }).first().click();
}

async function openCreateModal(page: Page, assetType: string) {
  const api = new MockApi('OFFICER');
  installCollateralApi(api, newWorld());
  await api.install(page);
  const guard = guardConsole(page);
  await page.goto(COLLATERAL_PAGE);
  await page.getByRole('button', { name: 'Барьцаа нэмэх' }).first().click();
  const modal = page.getByRole('dialog', { name: 'Барьцаа нэмэх' });
  await expect(modal).toBeVisible();
  await choose(page, modal, 'Хөрөнгийн төрөл', assetType);
  return { api, guard, modal };
}

async function fillVehicle(modal: Locator) {
  await modal.getByLabel('Улсын дугаар').fill('1234УБА');
  await modal.getByLabel('Үйлдвэрлэгч (марк)').fill('Toyota');
  await modal.getByLabel('Загвар').fill('Prius');
  await modal.getByLabel('Үйлдвэрлэсэн он').fill('2012');
}

const add = (modal: Locator) => modal.getByRole('button', { name: 'Нэмэх' });
const posts = (api: MockApi) => api.callsTo('POST', COLLATERALS);

test.describe('Барьцааны форм: тоон талбарууд', () => {
  test('гүйлт "5сая" нь 5км болж хадгалагдахгүй: алдаа, текст хэвээр, серверт явахгүй', async ({ page }) => {
    const { api, modal } = await openCreateModal(page, 'Тээврийн хэрэгсэл');
    await fillVehicle(modal);
    await modal.getByLabel('Гүйлт').fill('5сая');
    await add(modal).click();
    await expect(modal.getByText(NOT_NUMBER)).toBeVisible();
    await expect(modal.getByLabel('Гүйлт')).toHaveValue('5сая');
    expect(posts(api)).toHaveLength(0);
  });

  test('гүйлт "-5" нь 0 болж хувирахгүй: алдаа гарч, серверт явахгүй', async ({ page }) => {
    const { api, modal } = await openCreateModal(page, 'Тээврийн хэрэгсэл');
    await fillVehicle(modal);
    await modal.getByLabel('Гүйлт').fill('-5');
    await add(modal).click();
    await expect(modal.getByText('0-аас багагүй байх ёстой')).toBeVisible();
    await expect(modal.getByLabel('Гүйлт')).toHaveValue('-5');
    expect(posts(api)).toHaveLength(0);
  });

  test('бүхэл тоон талбарт 2012.5 нь 2013 болж дугуйлагдахгүй: "бүхэл тоо" алдаа', async ({ page }) => {
    const { api, modal } = await openCreateModal(page, 'Тээврийн хэрэгсэл');
    await fillVehicle(modal);
    await modal.getByLabel('Үйлдвэрлэсэн он').fill('2012.5');
    await add(modal).click();
    await expect(modal.getByText('Үйлдвэрлэсэн он бүхэл тоо байх ёстой')).toBeVisible();
    await expect(modal.getByLabel('Үйлдвэрлэсэн он')).toHaveValue('2012.5');
    expect(posts(api)).toHaveLength(0);
  });

  test('зөв утгууд ("150000" км, 2012 он) хэвээр илгээгдэнэ', async ({ page }) => {
    const { api, guard, modal } = await openCreateModal(page, 'Тээврийн хэрэгсэл');
    await fillVehicle(modal);
    await modal.getByLabel('Гүйлт').fill('150000');
    await add(modal).click();
    await expect(modal).toBeHidden();
    expect(posts(api)).toHaveLength(1);
    expect(api.lastCall('POST', COLLATERALS)?.body).toMatchObject({ assetType: 'VEHICLE', description: { manufactureYear: 2012, mileageKm: 150_000 } });
    expectClean(guard, api);
  });

  test('₮ талбар (тооллогын үнэ): "-5" → алдаа, "5сая" → 5,000,000₮ болж хадгалагдана', async ({ page }) => {
    const { api, modal } = await openCreateModal(page, 'Бараа материал');
    await modal.getByLabel(/^Нэр/).fill('Тавилга');
    await modal.getByLabel('Тооллого хийсэн огноо').fill('2026-11-01');
    await modal.getByLabel('Тооллогын үнэ').fill('-5');
    await add(modal).click();
    await expect(modal.getByText('Сөрөг дүн оруулах боломжгүй')).toBeVisible();
    await expect(modal.getByLabel('Тооллогын үнэ')).toHaveValue('-5');
    expect(posts(api)).toHaveLength(0);

    await modal.getByLabel('Тооллогын үнэ').fill('5сая');
    await modal.getByLabel('Тооллогын үнэ').blur();
    await expect(modal.getByLabel('Тооллогын үнэ')).toHaveValue('5,000,000');
    await add(modal).click();
    await expect(modal).toBeHidden();
    expect(api.lastCall('POST', COLLATERALS)?.body).toMatchObject({ assetType: 'INVENTORY', description: { name: 'Тавилга', stocktakeValue: 5_000_000 } });
  });

  test('талбай (бутархай талбар) "5сая" нь 5м² болж хадгалагдахгүй', async ({ page }) => {
    const { api, modal } = await openCreateModal(page, 'Орон сууц');
    await modal.getByLabel('Аймаг, хот').fill('Улаанбаатар');
    await modal.getByLabel('Сум, дүүрэг').fill('Хан-Уул');
    await modal.getByLabel('Өмчлөх эрхийн дугаар (ХУР)').fill('Ү-2201001234');
    await modal.getByLabel('Талбай').fill('5сая');
    await add(modal).click();
    await expect(modal.getByText(NOT_NUMBER)).toBeVisible();
    await expect(modal.getByLabel('Талбай')).toHaveValue('5сая');
    expect(posts(api)).toHaveLength(0);
  });
});

// ── Үнэлгээний гүйлт ────────────────────────────────────────────────────────────────────────────────────────────────────────
const SUGGEST = '/applications/:aid/collaterals/:cid/valuation/suggest';

async function openValuationTab(page: Page) {
  const api = new MockApi('OFFICER');
  installCollateralApi(api, newWorld({ items: [makeCollateral({ ownership: makeOwnership(), encumbrance: makeEncumbrance() })] }));
  await api.install(page);
  const guard = guardConsole(page);
  await page.goto(COLLATERAL_PAGE);
  await page.getByTestId('collateral-card').first().getByRole('button', { name: /^Дэлгэрэнгүй/ }).click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer).toBeVisible();
  const tab = drawer.getByRole('tab', { name: 'Үнэлгээ' });
  await expect(async () => {
    await tab.click({ timeout: 2_000 });
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  return { api, guard, drawer };
}

const suggestBtn = (drawer: Locator) => drawer.getByRole('button', { name: 'Системийн санал авах' });

test.describe('Үнэлгээ: тээврийн хэрэгслийн гүйлт', () => {
  test('"5сая" нь 5км болж саналд орохгүй: алдаа гарч, санал авах хүсэлт явахгүй', async ({ page }) => {
    const { api, drawer } = await openValuationTab(page);
    await drawer.getByLabel('Гүйлт').fill('5сая');
    await suggestBtn(drawer).click();
    await expect(drawer.getByText(NOT_NUMBER)).toBeVisible();
    await expect(drawer.getByLabel('Гүйлт')).toHaveValue('5сая');
    expect(api.callsTo('POST', SUGGEST)).toHaveLength(0);
  });

  test('"-5" ба 3,000,000 нь 0 / 2,000,000 болж clamp хийгдэхгүй: хүрээний алдаа', async ({ page }) => {
    const { api, drawer } = await openValuationTab(page);
    for (const bad of ['-5', '3000000']) {
      await drawer.getByLabel('Гүйлт').fill(bad);
      await suggestBtn(drawer).click();
      await expect(drawer.getByText('Гүйлт 0–2000000 хооронд байх ёстой'), bad).toBeVisible();
      await expect(drawer.getByLabel('Гүйлт'), bad).toHaveValue(bad);
    }
    expect(api.callsTo('POST', SUGGEST)).toHaveLength(0);
  });

  test('зөв гүйлт "150000" санал авах хүсэлтэд хэвээр явна', async ({ page }) => {
    const { api, drawer } = await openValuationTab(page);
    await drawer.getByLabel('Гүйлт').fill('150000');
    await suggestBtn(drawer).click();
    await expect.poll(() => api.callsTo('POST', SUGGEST).length).toBe(1);
    expect(api.callsTo('POST', SUGGEST)[0]!.body).toMatchObject({ mileageKm: 150_000 });
  });
});

// ── 4 нүдний бодлого: хүчинтэй хугацаа (F9-28, клиент тал) ─────────────────────────────────────────────────────────────────
const POLICY = MakerCheckerPolicyDto.parse({
  targetType: 'PRODUCT', action: 'CREATE', enabled: true, checkerRoles: ['ADMIN'], expiresInHours: 72, configured: true, locked: false, makerRoles: ['ADMIN'], updatedAt: AT, updatedBy: null,
});
const POLICY_PUT = '/maker-checker/policies/:type/:action';
const EXPIRES_INVALID = '1–720 цагийн хооронд бүхэл тоо оруулна уу';

async function openPolicyModal(page: Page) {
  const api = new MockApi('ADMIN');
  api.get('/maker-checker/policies', { json: [POLICY] });
  api.get('/maker-checker/requests/summary', { json: { inbox: 0, mine: 0 } });
  api.get('/maker-checker/requests', { json: { items: [], total: 0, page: 1, pageSize: 20 } });
  api.put(POLICY_PUT, ({ body }) => ({ status: 202, json: pendingResult('MAKER_CHECKER_POLICY', 'UPDATE', body) }));
  await api.install(page);
  guardConsole(page);
  await page.goto('/los/maker-checker?tab=policies');
  await page.getByRole('button', { name: 'Засах' }).first().click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  return { api, modal };
}

test.describe('F9-28: бодлогын хүчинтэй хугацаа (цаг)', () => {
  test('0, 1000, "5сая", "-5" нь 1 / 720 / 72 болж чимээгүй засагдахгүй: алдаа, текст хэвээр, илгээх товч идэвхгүй', async ({ page }) => {
    const { api, modal } = await openPolicyModal(page);
    const hours = modal.getByLabel('Хүчинтэй хугацаа (цаг)');
    await modal.locator('textarea').fill('Хугацааг өөрчилсөн');
    for (const bad of ['0', '1000', '5сая', '-5']) {
      await hours.fill(bad);
      await hours.blur();
      await expect(modal.getByText(EXPIRES_INVALID), bad).toBeVisible();
      await expect(hours, bad).toHaveValue(bad);
      await expect(modal.getByRole('button', { name: 'Хүсэлт илгээх' }), bad).toBeDisabled();
    }
    expect(api.callsTo('PUT', POLICY_PUT)).toHaveLength(0);
  });

  test('зөв хугацаа ("48") хэвээр илгээгдэнэ', async ({ page }) => {
    const { api, modal } = await openPolicyModal(page);
    await modal.getByLabel('Хүчинтэй хугацаа (цаг)').fill('48');
    await modal.locator('textarea').fill('Хугацааг өөрчилсөн');
    await expect(modal.getByRole('button', { name: 'Хүсэлт илгээх' })).toBeEnabled();
    await modal.getByRole('button', { name: 'Хүсэлт илгээх' }).click();
    await expect.poll(() => api.callsTo('PUT', POLICY_PUT).length).toBe(1);
    expect(api.callsTo('PUT', POLICY_PUT)[0]!.body).toMatchObject({ expiresInHours: 48, reason: 'Хугацааг өөрчилсөн' });
  });
});
