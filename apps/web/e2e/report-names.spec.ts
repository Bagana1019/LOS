import { expect, test, type Page } from '@playwright/test';
import { OrgDirectory, ReportDefinitionView, ReportResult } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F11-4 c: JSON тайлангийн хүснэгтэд "Салбар" / "ЗЭЗ" баганад түүхий UUID харагддаг байв (Excel-д нэр). Одоо хүснэгт нь
// gateway лавлахаар (useLookups) нэр болгоно; танихгүй id → "Тодорхойгүй" (хэзээ ч UUID биш); API өөрчлөгдөөгүй (id хэвээр ирнэ).
// F11-3 hint: хайлтын тайлбар жишээтэй.
const HQ = '00000000-0000-4000-8000-000000000101';
const SBD = '00000000-0000-4000-8000-000000000102';
const U1 = '00000000-0000-4000-8000-0000000000a1';
const UNKNOWN_BRANCH = '00000000-0000-4000-8000-000000000999';
const UNKNOWN_OFFICER = '00000000-0000-4000-8000-0000000009a9';
const UNKNOWN = 'Тодорхойгүй';

const DIRECTORY = OrgDirectory.parse({
  branches: { [HQ]: 'Төв салбар', [SBD]: 'Сүхбаатар салбар' },
  users: { [U1]: 'Батаа Дорж' },
});

const KEY = 'disbursed-loans';
const AT = '2026-11-21T03:00:00.000Z';
const DEFINITION = ReportDefinitionView.parse({
  key: KEY,
  title: 'Олгосон зээлийн тайлан',
  description: 'Тестийн тодорхойлолт',
  columns: [
    { key: 'appNo', label: 'Хүсэлтийн дугаар', type: 'string', sortable: true },
    { key: 'branchId', label: 'Салбар', type: 'string', sortable: false },
    { key: 'officerId', label: 'ЗЭЗ', type: 'string', sortable: false },
  ],
  filters: [{ key: 'search', label: 'Хайх (регистр, гэрээний дугаар, нэр)', type: 'text' }],
  dataSource: 'origination',
});

const ROWS = [
  { appNo: 'APP-1', branchId: HQ, officerId: U1 },
  { appNo: 'APP-2', branchId: SBD, officerId: UNKNOWN_OFFICER },
  { appNo: 'APP-3', branchId: UNKNOWN_BRANCH, officerId: 'Систем' }, // 'Систем' = ЗЭЗ-гүй (BR-12), id биш шошго
  { appNo: 'APP-4', branchId: HQ, officerId: null },
];

async function setup(page: Page, directory: 'ok' | 'forbidden' = 'ok') {
  const api = new MockApi('ADMIN');
  api.get('/directory', directory === 'ok' ? { json: DIRECTORY } : { status: 403, json: { code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' } });
  api.get('/reports', { json: [DEFINITION] });
  api.get('/reports/:key', ({ params }) => ({
    json: ReportResult.parse({ key: params.key, title: DEFINITION.title, columns: DEFINITION.columns, rows: ROWS, total: ROWS.length, page: 1, pageSize: 20, asOf: '2026-11-21', generatedAt: AT }),
  }));
  await api.install(page);
  return { api, guard: guardConsole(page) };
}

const rowOf = (page: Page, appNo: string) => page.locator('tbody tr', { hasText: appNo });
const cell = (page: Page, appNo: string, index: number) => rowOf(page, appNo).locator('td').nth(index);
const expectNoIds = async (page: Page) => {
  const html = await page.content();
  for (const id of [UNKNOWN_BRANCH, UNKNOWN_OFFICER, HQ, SBD, U1]) expect(html, id).not.toContain(id);
};

test.describe('Тайлангийн хүснэгт: салбар / ЗЭЗ нэрээр (F11-4 c)', () => {
  test('known branch / officer ids render as names; the API is still asked for the same report', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`/los/report/${KEY}`);

    await expect(rowOf(page, 'APP-1')).toBeVisible();
    await expect(cell(page, 'APP-1', 1)).toHaveText('Төв салбар');
    await expect(cell(page, 'APP-1', 2)).toHaveText('Батаа Дорж');
    await expect(cell(page, 'APP-2', 1)).toHaveText('Сүхбаатар салбар');
    expect(api.callsTo('GET', `/reports/${KEY}`).length).toBeGreaterThan(0);
    expectClean(guard, api);
  });

  test('an id missing from the directory shows "Тодорхойгүй", never the UUID; "Систем" and empty cells stay as they are', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`/los/report/${KEY}`);

    await expect(cell(page, 'APP-2', 2)).toHaveText(UNKNOWN);
    await expect(cell(page, 'APP-3', 1)).toHaveText(UNKNOWN);
    await expect(cell(page, 'APP-3', 2)).toHaveText('Систем');
    await expect(cell(page, 'APP-4', 2)).toHaveText('—');
    await expectNoIds(page);
    expectClean(guard, api);
  });

  test('when the directory cannot be loaded the table still never leaks UUIDs (names are unknown, not "found")', async ({ page }) => {
    const { api, guard } = await setup(page, 'forbidden');
    await page.goto(`/los/report/${KEY}`);

    await expect(rowOf(page, 'APP-1')).toBeVisible();
    await expect(cell(page, 'APP-1', 1)).toHaveText(UNKNOWN);
    await expect(cell(page, 'APP-3', 2)).toHaveText('Систем');
    await expectNoIds(page);
    expectClean(guard, api);
  });

  test('the search hint carries a concrete example (F11-3)', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(`/los/report/${KEY}`);

    await expect(page.getByText('Жишээ: Овог нэр бүтнээр, гэрээний дугаар, регистрийн бүтэн дугаар', { exact: false })).toBeVisible();
    expectClean(guard, api);
  });
});
