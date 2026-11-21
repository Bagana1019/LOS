import { expect, test, type Page } from '@playwright/test';
import type { ApprovalLevelApprover, ApprovalTimelineLevel, CannotVoteReason, DecisionView, OrgDirectory, UserRole } from '@los/contracts';
import { defaultApplicationDetail } from './application-shell';
import { expectClean } from './helpers';
import { guardConsole, MockApi, type MockReply } from './mock-api';

// F3-11: батлагч биш хүн шийдвэрийн хуудсанд товч ч, тайлбар ч харахгүй, түвшин «Шийдвэрлэж буй · Санал 1/1» гэхээс хэн батлахыг хэлдэггүй байсан.
// Одоо: «Та энэ түвшний батлагч биш» мөр + түвшин бүрд «Батлах эрхтэй: <нэр>» (нэр нь `/directory`-оос; UUID хэзээ ч харагдахгүй). Gateway mock.
const APP_ID = '00000000-0000-4000-8000-0000000000f3';
const URL = `/los/loan-application/${APP_ID}/decision`;
const USER_A = '00000000-0000-4000-8000-000000000a01';
const USER_B = '00000000-0000-4000-8000-000000000b02';
const GHOST = 'a3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const DIRECTORY: OrgDirectory = { branches: {}, users: { [USER_A]: 'Бат Болд', [USER_B]: 'Саруул' } };

const level = (levelNo: number, name: string, state: ApprovalTimelineLevel['state'], approvers: ApprovalLevelApprover[]): ApprovalTimelineLevel => ({
  levelNo, name, state, startedAt: '2026-11-20T04:00:00.000Z', dueAt: state === 'PENDING' ? '2026-11-21T04:00:00.000Z' : null, overdue: false,
  quorum: { required: 1, total: approvers.length }, votes: [], approvers,
});

function makeView(o: { reason?: CannotVoteReason | null; levels?: ApprovalTimelineLevel[] } = {}): DecisionView {
  const reason = o.reason === undefined ? 'NOT_LEVEL_APPROVER' : o.reason;
  return {
    applicationId: APP_ID, appNo: 'LA-2026-000002', status: 'IN_APPROVAL', version: 1,
    summary: {
      borrowerName: 'Бат Болд', registerNoMasked: 'УБ****01', productName: 'Хэрэглээний', currency: 'MNT', amount: 5_000_000, termMonths: 12, interestRate: 28, monthlyPayment: 482_529.94,
      collateralCount: 0, selectedMethod: null, risk: null,
    },
    progress: { completed: 8, total: 8, missing: [], reasons: {} }, canSubmit: false,
    approval: {
      currentLevel: 1, totalLevels: 2,
      levels: o.levels ?? [level(1, 'Салбар', 'PENDING', [{ userId: USER_A, role: null }]), level(2, 'Төв', 'WAITING', [{ userId: USER_B, role: null }, { userId: null, role: 'APPROVER' }])],
    },
    versions: [], decisionRecord: null, canVote: reason === null, cannotVoteReason: reason,
  };
}

function inApprovalDetail(id: string) {
  const d = defaultApplicationDetail(id);
  return { ...d, status: 'IN_APPROVAL' as const, editable: false, stage1Completed: 9, stage1Total: 9, steps: d.steps.map((s) => (s.stage === 1 ? { ...s, status: 'COMPLETED' as const } : s)) };
}

async function setup(page: Page, o: { role?: UserRole; view?: DecisionView; directory?: MockReply } = {}) {
  const api = new MockApi(o.role ?? 'APPROVER');
  api.get('/applications/:id', ({ params }) => ({ json: inApprovalDetail(params.id) }));
  api.get('/applications/:id/decision', () => ({ json: o.view ?? makeView() }));
  api.get('/directory', o.directory ?? { json: DIRECTORY });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

const reason = (page: Page) => page.getByTestId('cannot-vote-reason');
const approvers = (page: Page, levelNo: number) => page.getByTestId(`level-approvers-${levelNo}`);

test.describe('Шийдвэрийн хуудас: хэн санал өгөх, яагаад чадахгүй (F3-11)', () => {
  test('non-member approver: sees why there are no vote buttons and who decides each level, by name', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    await expect(reason(page)).toContainText('Та энэ түвшний батлагч биш');
    await expect(page.getByTestId('vote-approve')).toHaveCount(0);
    await expect(page.getByTestId('vote-return')).toHaveCount(0);
    await expect(approvers(page, 1)).toHaveText('Батлах эрхтэй: Бат Болд');
    await expect(approvers(page, 2)).toHaveText('Батлах эрхтэй: Саруул, Батлагч'); // хүлээгдэж буй түвшин; дүрээр томилсон нь дүрийн шошгоор
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(USER_A);
    expect(body).not.toContain(USER_B);
    expect(body).not.toContain('NOT_LEVEL_APPROVER');
    expectClean(guard, api);
  });

  for (const [code, text] of [
    ['ALREADY_VOTED', 'Та энэ түвшинд санал өгсөн байна'],
    ['OWN_APPLICATION', 'Өөрийн үүсгэсэн хүсэлтийг батлах боломжгүй'],
  ] as const) {
    test(`${code}: says "${text}" and still lists who may vote`, async ({ page }) => {
      const { api, guard } = await setup(page, { role: 'BRANCH_MANAGER', view: makeView({ reason: code }) });
      await page.goto(URL);
      await expect(reason(page)).toContainText(text);
      await expect(page.getByTestId('vote-approve')).toHaveCount(0);
      await expect(approvers(page, 1)).toHaveText('Батлах эрхтэй: Бат Болд');
      await expect(page.getByText(code)).toHaveCount(0);
      expectClean(guard, api);
    });
  }

  test('level approver who can vote: sees the buttons and no reason line, and the approver names stay', async ({ page }) => {
    const { api, guard } = await setup(page, { role: 'BRANCH_MANAGER', view: makeView({ reason: null }) });
    await page.goto(URL);
    await expect(page.getByTestId('vote-approve')).toBeVisible();
    await expect(page.getByTestId('vote-return')).toBeVisible();
    await expect(reason(page)).toHaveCount(0);
    await expect(approvers(page, 1)).toHaveText('Батлах эрхтэй: Бат Болд');
    expectClean(guard, api);
  });

  test('approver missing from the directory shows «Тодорхойгүй», never the raw id', async ({ page }) => {
    const levels = [level(1, 'Салбар', 'PENDING', [{ userId: GHOST, role: null }, { userId: USER_A, role: null }])];
    const { api, guard } = await setup(page, { view: makeView({ levels }) });
    await page.goto(URL);
    await expect(approvers(page, 1)).toHaveText('Батлах эрхтэй: Тодорхойгүй, Бат Болд');
    expect(await page.locator('body').innerText()).not.toContain(GHOST);
    expectClean(guard, api);
  });

  test('directory lookup refused (403): names fall back to «Тодорхойгүй», page and reason line still work, no id leaks', async ({ page }) => {
    const { api } = await setup(page, { directory: { status: 403, json: { code: 'FORBIDDEN', message: 'Forbidden' } } });
    await page.goto(URL);
    await expect(approvers(page, 1)).toHaveText('Батлах эрхтэй: Тодорхойгүй');
    await expect(reason(page)).toContainText('Та энэ түвшний батлагч биш');
    expect(await page.locator('body').innerText()).not.toContain(USER_A);
    expect(api.unhandled).toEqual([]);
  });

  test('level without any appointed approver says so instead of an empty «Батлах эрхтэй:»', async ({ page }) => {
    const { api, guard } = await setup(page, { view: makeView({ levels: [level(1, 'Салбар', 'PENDING', [])] }) });
    await page.goto(URL);
    await expect(approvers(page, 1)).toHaveText('Батлах эрхтэй хүн томилоогүй байна');
    expectClean(guard, api);
  });
});
