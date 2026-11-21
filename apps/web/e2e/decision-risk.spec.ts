import { expect, test, type Page } from '@playwright/test';
import type { DecisionRisk, DecisionView, UserRole } from '@los/contracts';
import { defaultApplicationDetail } from './application-shell';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F3-1: батлагчийн шийдвэрийн хуудас (`/los/loan-application/:id/decision`, FR-10). Gateway-г mock хийсэн.
// Батлагч өмнө нь «A_SALARY» түүхий enum, «8/8» шугам ба «Бүрдсэн 9/9» текст, эрсдэлийн ямар ч үзүүлэлтгүй хуудас харж байсан.
const APP_ID = '00000000-0000-4000-8000-0000000000e3';
const URL = `/los/loan-application/${APP_ID}/decision`;
const DECISION = '/applications/:id/decision';

const RISK: DecisionRisk = {
  method: 'A_SALARY', selection: 'AUTO', computedAt: '2026-11-20T03:00:00.000Z', stale: false,
  ratio: { kind: 'DTI', value: 0.4321, limit: 0.55, pass: true },
  ltv: { value: 0.0625, limit: 0.7, pass: true },
  sosco: { score: 712, grade: 'B' },
  collateral: { count: 2, totalValue: 80_000_000, required: true },
  income: { salaryMonthly: 2_500_000, businessNcfMonthly: 300_000, householdExpenseMonthly: 400_000 },
  flags: [],
};

function makeView(o: { risk?: DecisionRisk | null } = {}): DecisionView {
  return {
    applicationId: APP_ID, appNo: 'LA-2026-000001', status: 'IN_APPROVAL', version: 1,
    summary: {
      borrowerName: 'Бат Болд', registerNoMasked: 'УБ****01', productName: 'Хэрэглээний', currency: 'MNT', amount: 5_000_000, termMonths: 12, interestRate: 28, monthlyPayment: 482_529.94,
      collateralCount: 2, selectedMethod: 'A_SALARY', risk: o.risk === undefined ? RISK : o.risk,
    },
    progress: { completed: 8, total: 8, missing: [], reasons: {} }, canSubmit: false,
    approval: {
      currentLevel: 1, totalLevels: 1,
      levels: [{ levelNo: 1, name: 'Салбар', state: 'PENDING', startedAt: '2026-11-20T04:00:00.000Z', dueAt: '2026-11-21T04:00:00.000Z', overdue: false, quorum: { required: 1, total: 1 }, votes: [], approvers: [{ userId: null, role: 'BRANCH_MANAGER' }] }],
    },
    versions: [], decisionRecord: null, canVote: true, cannotVoteReason: null,
  };
}

/** Wizard-ийн зүүн самбар: батлах шатанд буй хүсэлт, 1-р үе шатны 9/9 алхам бүрдсэн («Бүрдсэн: 9/9»). */
function inApprovalDetail(id: string) {
  const d = defaultApplicationDetail(id);
  return { ...d, status: 'IN_APPROVAL' as const, editable: false, stage1Completed: 9, stage1Total: 9, steps: d.steps.map((s) => (s.stage === 1 ? { ...s, status: 'COMPLETED' as const } : s)) };
}

async function setup(page: Page, o: { risk?: DecisionRisk | null; role?: UserRole } = {}) {
  const api = new MockApi(o.role ?? 'BRANCH_MANAGER');
  api.get('/applications/:id', ({ params }) => ({ json: inApprovalDetail(params.id) }));
  api.get(DECISION, () => ({ json: makeView({ risk: o.risk }) }));
  api.get('/directory', { json: { branches: {}, users: {} } }); // F3-11: шийдвэрийн хуудас батлагчийн нэрийг лавлахаас авна
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

const text = (page: Page, id: string) => page.getByTestId(id);

test.describe('Шийдвэрийн хуудас: эрсдэлийн хураангуй (F3-1)', () => {
  test('approver sees method (Mongolian), DTI, LTV, Sosco, collateral, income and no raw enum', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    await expect(page.getByTestId('risk-card')).toBeVisible();
    await expect(page.getByText('Эрсдэлийн хураангуй')).toBeVisible();
    await expect(text(page, 'risk-method')).toHaveText('A · Цалин');
    await expect(text(page, 'decision-method')).toHaveText('A · Цалин'); // хураангуй картын «Сонгосон арга» ч мөн
    await expect(page.getByText('A_SALARY')).toHaveCount(0);
    await expect(text(page, 'risk-ratio')).toHaveText('43.21%');
    await expect(text(page, 'risk-ltv')).toHaveText('6.25%');
    await expect(text(page, 'risk-sosco')).toHaveText('712');
    await expect(text(page, 'risk-collateral')).toHaveText('2 барьцаа · 80,000,000₮');
    await expect(text(page, 'risk-income-salary')).toHaveText('2,500,000₮');
    await expect(text(page, 'risk-income-ncf')).toHaveText('300,000₮');
    await expect(text(page, 'risk-income-expense')).toHaveText('400,000₮');
    await expect(text(page, 'risk-no-flags')).toBeVisible();
    await expect(page.getByText('482,529.94₮')).toBeVisible(); // F3-1b: сарын төлбөр хэвээр
    expectClean(guard, api);
  });

  test('progress bar and the wizard counter show the same numbers, and say what they count', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    await expect(page.getByText('Бүрдсэн: 9/9').first()).toBeVisible(); // зүүн самбар
    await expect(page.locator('.ant-progress-text').first()).toHaveText('9/9'); // шугам — ижил тоо
    const caption = text(page, 'decision-progress-text');
    await expect(caption).toContainText('Бүрдсэн алхам (1-р үе шат): 9/9');
    await expect(caption).toContainText('Заавал бүрдэх алхам: 8/8'); // мэдээлэл нуугдаагүй
    expectClean(guard, api);
  });

  test('failing ratio, LTV and a stale calculation are flagged', async ({ page }) => {
    const risk: DecisionRisk = {
      ...RISK, stale: true,
      ratio: { kind: 'DTI', value: 0.61, limit: 0.55, pass: false }, ltv: { value: 0.8, limit: 0.7, pass: false },
      flags: [
        { code: 'CALCULATION_STALE', level: 'warning', message: 'Тооцоолол хуучирсан байна. Үзүүлэлтүүд одоогийн нөхцөлтэй таарахгүй байж болно' },
        { code: 'DTI_ABOVE_LIMIT', level: 'error', message: 'ӨОХ дээд хязгаараас хэтэрсэн' },
      ],
    };
    const { api, guard } = await setup(page, { risk });
    await page.goto(URL);
    await expect(text(page, 'risk-ratio')).toHaveText('61%');
    await expect(text(page, 'risk-stale')).toBeVisible();
    await expect(page.getByTestId('risk-flag')).toHaveCount(2);
    await expect(page.getByText('ӨОХ дээд хязгаараас хэтэрсэн')).toBeVisible();
    await expect(page.getByText('Хангахгүй')).toHaveCount(2); // ӨОХ ба LTV
    expectClean(guard, api);
  });

  test('no saved calculation: a clear message instead of an empty card', async ({ page }) => {
    const { api, guard } = await setup(page, { risk: null });
    await page.goto(URL);
    await expect(page.getByTestId('risk-missing')).toBeVisible();
    await expect(page.getByText('Тооцоолол хадгалагдаагүй байна.', { exact: false })).toBeVisible();
    await expect(page.getByTestId('risk-card')).toHaveCount(0);
    await expect(page.getByTestId('vote-approve')).toBeVisible(); // санал өгөх хэвээр (хуудас эвдрээгүй)
    expectClean(guard, api);
  });
});
