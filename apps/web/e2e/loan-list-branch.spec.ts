import { expect, test, type Locator, type Page } from '@playwright/test';
import { ApplicationListResponse, ApplicationRow, ApplicationStatus, OrgDirectory } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi, type MockReply } from './mock-api';

// F5-14: зээлийн жагсаалт /los/loan/list "Салбар" баганад UUID биш нэр (хүсэлтийн жагсаалттай ижил лавлах `/directory`-оор), мөр хуваагдахгүй. Gateway mock.
const BRANCH_ID = '00000000-0000-4000-8000-000000000101';
const BRANCH_NAME = 'Төв салбар';
const LONG_BRANCH_NAME = 'Баянзүрх дүүргийн Хан-Уул хорооллын нэгдсэн салбар';
const CONTRACT_NO = 'CN-2026-0007';
const AT = '2026-11-02T03:00:00.000Z';
const UNKNOWN = 'Тодорхойгүй';

const loanRow = ApplicationRow.parse({
  id: '22222222-2222-4222-8222-222222222222', appNo: 'LA-2026-000007', branchId: BRANCH_ID, officerId: null, contractNo: CONTRACT_NO, primaryBorrower: null, productId: null,
  productName: 'Хэрэглээний зээл', currency: 'MNT', amount: 5_000_000, interestRate: 24, termMonths: 12, decidedAt: AT, status: 'ACTIVE', stepsDone: 7, stepsRequired: 7, createdAt: AT,
});
const counts = () => Object.fromEntries(ApplicationStatus.map((s) => [s, s === 'ACTIVE' ? 1 : 0]));
const loanList = ApplicationListResponse.parse({ items: [loanRow], total: 1, page: 1, pageSize: 20, counts: counts(), myApprovalCount: 0 });
const directoryOf = (branches: Record<string, string>): MockReply => ({ json: OrgDirectory.parse({ branches, users: {} }) });
const FORBIDDEN: MockReply = { status: 403, json: { code: 'FORBIDDEN', message: 'Forbidden' } };

async function openLoanList(page: Page, directory: MockReply) {
  const api = new MockApi('OFFICER');
  await api.install(page);
  const guard = guardConsole(page);
  api.get('/applications', { json: loanList });
  api.get('/directory', directory);
  await page.goto('/los/loan/list');
  const row = page.getByRole('row', { name: new RegExp(CONTRACT_NO) });
  await expect(row).toBeVisible();
  return { api, guard, row };
}

/** Нүдний текст хэдэн мөрөнд буусныг (өөр өөр `top`-той мөрийн тоо) хэмжинэ. */
const visualLines = (cell: Locator) => cell.evaluate((el) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  return new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size;
});

test('"Салбар" баганад лавлахын нэр харагдана, UUID харагдахгүй', async ({ page }) => {
  const { api, guard, row } = await openLoanList(page, directoryOf({ [BRANCH_ID]: BRANCH_NAME }));
  await expect(row.getByRole('cell', { name: BRANCH_NAME, exact: true })).toBeVisible();
  await expect(page.getByText(BRANCH_ID)).toHaveCount(0);
  expect(api.callsTo('GET', '/directory')).toHaveLength(1);
  expectClean(guard, api);
});

test('лавлахад байхгүй салбар → "Тодорхойгүй", UUID хэзээ ч харагдахгүй', async ({ page }) => {
  const { row } = await openLoanList(page, directoryOf({ 'other-branch': BRANCH_NAME }));
  await expect(row.getByRole('cell', { name: UNKNOWN, exact: true })).toBeVisible();
  await expect(page.getByText(BRANCH_ID)).toHaveCount(0);
});

test('лавлах ачаалж чадаагүй (403) → "Тодорхойгүй", UUID хэзээ ч харагдахгүй', async ({ page }) => {
  const { row } = await openLoanList(page, FORBIDDEN);
  await expect(row.getByRole('cell', { name: UNKNOWN, exact: true })).toBeVisible();
  await expect(page.getByText(BRANCH_ID)).toHaveCount(0);
});

test('урт салбарын нэр нэг мөрөнд багтана (олон мөрөнд хуваагдахгүй)', async ({ page }) => {
  const { row } = await openLoanList(page, directoryOf({ [BRANCH_ID]: LONG_BRANCH_NAME }));
  const cell = row.getByRole('cell', { name: LONG_BRANCH_NAME, exact: true });
  await expect(cell).toBeVisible();
  expect(await visualLines(cell)).toBe(1);
});
