import { expect, test, type Page } from '@playwright/test';
import { AgingBucket, ApplicationStatus, DashboardSummary, OrgDirectory, ReportDefinitionView, ReportResult, type UserRole } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F11-1: /los/dashboard ба /los/report/* дахь "Салбар", "ЗЭЗ", "Бүтээгдэхүүн" шүүлт өмнө нь чөлөөт текст (зөвхөн UUID) байсан тул "Төв салбар", "100" гэх мэт
// бичсэн хэрэглэгч 200 + хоосон дэлгэц авч, толгой нь бичсэн текстийг зөв мэт давтдаг байв. Одоо нэрээр хайдаг Select (утга = id).
// Mock нэвтэрсэн ажилтан (mock-gateway.ts): id `id-officer.a`, салбар `branch`.
const HQ = '00000000-0000-4000-8000-000000000101';
const SBD = '00000000-0000-4000-8000-000000000102';
const OWN_BRANCH = 'branch';
const ME = 'id-officer.a';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const U3 = '00000000-0000-4000-8000-0000000000a3';
const P1 = '00000000-0000-4000-8000-000000000201';
const P2 = '00000000-0000-4000-8000-000000000202';
const UNKNOWN_BRANCH = '00000000-0000-4000-8000-000000000999';
const UNKNOWN_OFFICER = '00000000-0000-4000-8000-0000000009a9';
const UNKNOWN_PRODUCT = '00000000-0000-4000-8000-0000000009b9';

const DIRECTORY = OrgDirectory.parse({
  branches: { [HQ]: 'Төв салбар', [SBD]: 'Сүхбаатар салбар', [OWN_BRANCH]: 'Баянзүрх салбар' },
  users: { [ME]: 'Батаа Дорж', [U2]: 'Оюунчимэг Батсайхан', [U3]: 'Төмөр Болд' },
});

const REPORT_KEY = 'disbursed-loans';
const DEFINITION = ReportDefinitionView.parse({
  key: REPORT_KEY,
  title: 'Олгосон зээлийн тайлан',
  description: 'Тестийн тодорхойлолт',
  columns: [{ key: 'appNo', label: 'Хүсэлтийн дугаар', type: 'string', sortable: true }],
  filters: [
    { key: 'search', label: 'Хайх (регистр, гэрээний дугаар, нэр)', type: 'text' },
    { key: 'branchId', label: 'Салбар', type: 'text' },
    { key: 'officerId', label: 'ЗЭЗ', type: 'text' },
    { key: 'productId', label: 'Бүтээгдэхүүн', type: 'select', options: [{ value: P1, label: 'Хэрэглээний зээл' }, { value: P2, label: 'Бизнесийн зээл' }] },
  ],
  dataSource: 'origination',
});

const AT = '2026-11-21T03:00:00.000Z';
const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];

function makeSummary(scope: { branchId: string | null; officerId: string | null }): DashboardSummary {
  return DashboardSummary.parse({
    asOf: '2026-11-21', currency: 'MNT', scope,
    applications: { byStatus: ApplicationStatus.map((status) => ({ status, count: 0, amount: 0 })), submittedThisMonth: 0, approvedThisMonth: 0, returnedThisMonth: 0, approvalRate: null, avgDecisionHours: null },
    disbursements: { thisMonthAmount: 0, lastMonthAmount: 0, thisMonthCount: 0, yearToDateAmount: 0, monthly: MONTHS.map((month) => ({ month, amount: 0, count: 0 })) },
    portfolio: { activeLoanCount: 0, outstandingPrincipal: 0, overdueAmount: 0, overdueLoanCount: 0, parRatio: null, aging: AgingBucket.map((bucket) => ({ bucket, loanCount: 0, principal: 0 })) },
    collections: { dueThisMonth: 0, collectedThisMonth: 0, collectionRate: null, dueNext7Days: 0 },
    topProducts: [],
    generatedAt: AT,
  });
}

/** Жинхэнэ сервер шиг: dashboard-ын хүрээ нь ирсэн `branchId`-г (админд) тэр чигээр хариуд давтана. */
async function setup(page: Page, role: UserRole = 'ADMIN', directory: 'ok' | 'forbidden' = 'ok') {
  const api = new MockApi(role);
  api.get('/directory', directory === 'ok' ? { json: DIRECTORY } : { status: 403, json: { code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' } });
  api.get('/reports', { json: [DEFINITION] });
  api.get('/reports/dashboard/summary', ({ search }) => ({ json: makeSummary({ branchId: search.get('branchId'), officerId: null }) }));
  api.get('/reports/:key', ({ params }) => ({
    json: ReportResult.parse({ key: params.key, title: DEFINITION.title, columns: DEFINITION.columns, rows: [], total: 0, page: 1, pageSize: 20, asOf: '2026-11-21', generatedAt: AT }),
  }));
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

const combo = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });
const selectOf = (page: Page, name: string) => page.locator('.ant-select').filter({ has: combo(page, name) });
const openDropdown = (page: Page) => page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
const apply = (page: Page) => page.getByRole('button', { name: 'Хайх', exact: true });
// antd (rc-select) нь хүртээмжийн нууц `role="listbox"` (0x0, overflow hidden) дотор сонголтын утгыг (id) текстээр агуулдаг — хэрэглэгчид харагдахгүй (screen reader нэрийг aria-label-ээс уншина). Тиймээс зөвхөн харагдаж буй текстийг тоолно.
const visibleText = (page: Page, text: string) => page.getByText(text).filter({ visible: true });
const dashboardCalls = (api: MockApi) => api.callsTo('GET', '/reports/dashboard/summary');
const reportCalls = (api: MockApi) => api.callsTo('GET', `/reports/${REPORT_KEY}`);

async function choose(page: Page, name: string, optionText: string) {
  await combo(page, name).click();
  await openDropdown(page).locator('.ant-select-item-option', { hasText: optionText }).click();
}

const NOT_FOUND = {
  branch: 'Салбар олдсонгүй. Жагсаалтаас сонгоно уу.',
  officer: 'Ажилтан олдсонгүй. Жагсаалтаас сонгоно уу.',
  product: 'Бүтээгдэхүүн олдсонгүй. Жагсаалтаас сонгоно уу.',
};

test.describe('Dashboard: салбарын шүүлт (F11-1)', () => {
  test('branch is a searchable Select of names; choosing a name sends the id and the header shows the name, not the UUID', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto('/los/dashboard');
    await expect(combo(page, 'Салбар')).toBeVisible();
    await expect.poll(() => dashboardCalls(api).length).toBeGreaterThan(0);

    await combo(page, 'Салбар').fill('Төв');
    await expect(openDropdown(page).locator('.ant-select-item-option')).toHaveText(['Төв салбар']); // Сүхбаатар/Баянзүрх шүүгдсэн
    await openDropdown(page).locator('.ant-select-item-option', { hasText: 'Төв салбар' }).click();
    await apply(page).click();

    await expect.poll(() => dashboardCalls(api).at(-1)?.search.get('branchId')).toBe(HQ);
    await expect(page).toHaveURL(new RegExp(`[?&]branchId=${HQ}(&|$)`));
    await expect(page.getByText('Хүрээ: салбар Төв салбар', { exact: false })).toBeVisible();
    await expect(selectOf(page, 'Салбар')).toContainText('Төв салбар');
    await expect(visibleText(page, HQ)).toHaveCount(0); // UUID дэлгэцэнд харагдахгүй
    expectClean(guard, api);
  });

  test('a free-typed name cannot be applied: no option matches and no branchId is sent', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto('/los/dashboard');
    await expect.poll(() => dashboardCalls(api).length).toBeGreaterThan(0);

    await combo(page, 'Салбар').fill('100');
    await expect(page.getByText('Таарах сонголт олдсонгүй')).toBeVisible();
    await apply(page).click();
    expect(dashboardCalls(api).every((c) => c.search.get('branchId') === null)).toBe(true);
    expectClean(guard, api);
  });

  test('an unknown id from the URL stays visible as the raw value with a "not found" hint; the header does not pass it off as valid', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`/los/dashboard?branchId=${UNKNOWN_BRANCH}`);
    await expect(page.getByText(NOT_FOUND.branch, { exact: true })).toBeVisible();
    await expect(selectOf(page, 'Салбар')).toContainText(UNKNOWN_BRANCH);
    await expect.poll(() => dashboardCalls(api).at(-1)?.search.get('branchId')).toBe(UNKNOWN_BRANCH); // API параметр хэвээр
    await expect(page.getByText(`Хүрээ: салбар олдсонгүй (${UNKNOWN_BRANCH})`, { exact: false })).toBeVisible();
    expectClean(guard, api);
  });

  test('a known id in the URL resolves to its name without any hint', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`/los/dashboard?branchId=${SBD}`);
    await expect(selectOf(page, 'Салбар')).toContainText('Сүхбаатар салбар');
    await expect(page.getByText('Хүрээ: салбар Сүхбаатар салбар', { exact: false })).toBeVisible();
    await expect(page.getByText(NOT_FOUND.branch, { exact: true })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('BRANCH_MANAGER is only offered the own branch', async ({ page }) => {
    const { api, guard } = await setup(page, 'BRANCH_MANAGER');
    await page.goto('/los/dashboard');
    await combo(page, 'Салбар').click();
    await expect(openDropdown(page).locator('.ant-select-item-option')).toHaveText(['Баянзүрх салбар']);
    expectClean(guard, api);
  });

  test('when the directory cannot be loaded the filter says so instead of pretending to be empty', async ({ page }) => {
    const { api } = await setup(page, 'ADMIN', 'forbidden');
    await page.goto('/los/dashboard');
    await expect(page.getByText('Жагсаалтыг ачаалж чадсангүй. Хуудсыг шинэчлээд дахин оролдоно уу.')).toBeVisible();
    await expect.poll(() => dashboardCalls(api).length).toBeGreaterThan(0); // самбар өөрөө ажилласан хэвээр
  });
});

test.describe('Тайлан: салбар, ЗЭЗ, бүтээгдэхүүний шүүлт (F11-1)', () => {
  const URL = `/los/report/${REPORT_KEY}`;

  test('branch, officer and product are Selects of names; choosing sends the ids the API expects', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    for (const name of ['Салбар', 'ЗЭЗ', 'Бүтээгдэхүүн']) await expect(combo(page, name)).toBeVisible();

    await choose(page, 'Салбар', 'Төв салбар');
    await choose(page, 'ЗЭЗ', 'Оюунчимэг Батсайхан');
    await choose(page, 'Бүтээгдэхүүн', 'Бизнесийн зээл');
    await apply(page).click();

    await expect.poll(() => reportCalls(api).at(-1)?.search.get('branchId')).toBe(HQ);
    const last = reportCalls(api).at(-1)!.search;
    expect(last.get('officerId')).toBe(U2);
    expect(last.get('productId')).toBe(P2);
    await expect(page).toHaveURL(new RegExp(`branchId=${HQ}`));
    await expect(visibleText(page, HQ)).toHaveCount(0);
    expectClean(guard, api);
  });

  test('the free-text search box is untouched', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    await expect(page.getByRole('textbox', { name: 'Хайх (регистр, гэрээний дугаар, нэр)' })).toBeVisible();
    expectClean(guard, api);
  });

  test('unknown ids from the URL are flagged "not found" (product too) and still sent unchanged', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`${URL}?branchId=${UNKNOWN_BRANCH}&officerId=${UNKNOWN_OFFICER}&productId=${UNKNOWN_PRODUCT}`);
    for (const hint of Object.values(NOT_FOUND)) await expect(page.getByText(hint, { exact: true })).toBeVisible();
    await expect(selectOf(page, 'Салбар')).toContainText(UNKNOWN_BRANCH);
    await expect(selectOf(page, 'ЗЭЗ')).toContainText(UNKNOWN_OFFICER);
    await expect(selectOf(page, 'Бүтээгдэхүүн')).toContainText(UNKNOWN_PRODUCT);
    await expect.poll(() => reportCalls(api).at(-1)?.search.get('productId')).toBe(UNKNOWN_PRODUCT);
    const last = reportCalls(api).at(-1)!.search;
    expect(last.get('branchId')).toBe(UNKNOWN_BRANCH);
    expect(last.get('officerId')).toBe(UNKNOWN_OFFICER);
    expectClean(guard, api);
  });

  test('known ids from the URL show names and no hint', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`${URL}?branchId=${HQ}&officerId=${U3}&productId=${P1}`);
    await expect(selectOf(page, 'Салбар')).toContainText('Төв салбар');
    await expect(selectOf(page, 'ЗЭЗ')).toContainText('Төмөр Болд');
    await expect(selectOf(page, 'Бүтээгдэхүүн')).toContainText('Хэрэглээний зээл');
    for (const hint of Object.values(NOT_FOUND)) await expect(page.getByText(hint, { exact: true })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('OFFICER is only offered self and the own branch', async ({ page }) => {
    const { api, guard } = await setup(page, 'OFFICER');
    await page.goto(URL);
    await combo(page, 'ЗЭЗ').click();
    await expect(openDropdown(page).locator('.ant-select-item-option')).toHaveText(['Батаа Дорж']);
    await page.keyboard.press('Escape');
    await combo(page, 'Салбар').click();
    await expect(openDropdown(page).locator('.ant-select-item-option')).toHaveText(['Баянзүрх салбар']);
    expectClean(guard, api);
  });

  test('BRANCH_MANAGER is offered the own branch only, but every officer', async ({ page }) => {
    const { api, guard } = await setup(page, 'BRANCH_MANAGER');
    await page.goto(URL);
    await combo(page, 'Салбар').click();
    await expect(openDropdown(page).locator('.ant-select-item-option')).toHaveText(['Баянзүрх салбар']);
    await page.keyboard.press('Escape');
    await combo(page, 'ЗЭЗ').click();
    await expect(openDropdown(page).locator('.ant-select-item-option')).toHaveText(['Батаа Дорж', 'Оюунчимэг Батсайхан', 'Төмөр Болд']);
    expectClean(guard, api);
  });
});
