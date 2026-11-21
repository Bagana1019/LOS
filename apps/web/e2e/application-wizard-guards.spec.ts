import { expect, test, type Page } from '@playwright/test';
import { ApplicationDetail, ScheduleResponse, StepKey, TransitionRequest, type StepStatus } from '@los/contracts';
import { makeRow } from '../src/features/documents/documents.fixtures';
import { makeCalculation, makeOverview } from '../src/features/score/testing/fixtures';
import { installDocumentsApi, newDocWorld } from './documents-mock';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Wizard-ийн хамгаалалтууд (Chrome naive-user test): F2-3/F3-6 «Илгээх» хаалт, F2-27 баримтын дараах зүүн самбар, F3-7 хуучирсан ЭТХ, F3-8 хуучирсан тооцоолол.
// Gateway mock. Сервер талын дүрэм (blockedBy = заавал алхмаас COMPLETED биш нь) энд зөвхөн хуурамч серверийн хэсэг; UI дүрмийг дахин тооцохгүй гэдгийг шалгана.
const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-02T03:00:00.000Z';
const STAGE2: StepKey[] = ['contract', 'official_documents', 'disburse'];
const REQUIRED: StepKey[] = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'];

interface Shape { done?: StepKey[]; stale?: StepKey[]; required?: StepKey[]; status?: 'DRAFT' | 'RETURNED' }

function detail({ done = [], stale = [], required = REQUIRED, status = 'DRAFT' }: Shape = {}): ApplicationDetail {
  const stepStatus = (k: StepKey): StepStatus => (STAGE2.includes(k) ? 'LOCKED' : done.includes(k) ? 'COMPLETED' : stale.includes(k) ? 'STALE' : 'PENDING');
  return ApplicationDetail.parse({
    id: ID, appNo: 'LA-2026-000001', branchId: 'b1', officerId: 'u1', contractNo: null, primaryBorrower: null, productId: null, productName: null, currency: 'MNT', amount: null, interestRate: null, termMonths: null,
    decidedAt: null, status, stepsDone: done.length, stepsRequired: required.length, createdAt: AT, officerNote: null, purpose: null, version: 1, source: 'WEB',
    submittedAt: null, approvedAt: null, returnedAt: null, editable: true, stage1Completed: done.length, stage1Total: 9,
    steps: StepKey.map((stepKey, i) => ({ stepKey, stage: STAGE2.includes(stepKey) ? 2 : 1, order: i + 1, status: stepStatus(stepKey), required: required.includes(stepKey), completedAt: done.includes(stepKey) ? AT : null, staleReason: null })),
    transitions: [{ to: 'SUBMITTED', allowed: true, blockedBy: required.filter((k) => !done.includes(k)) }],
  });
}

async function setup(page: Page, app: () => ApplicationDetail) {
  const api = new MockApi('OFFICER');
  api.get('/applications/:id', () => ({ json: app() }));
  api.get('/applications/:id/score', () => ({ json: makeOverview() })); // хост алхам: шинэ spec бүр өөрийн алхмын mock-оор дарж болно
  return { api, guard: guardConsole(page), install: () => api.install(page) };
}

const submit = (page: Page) => page.getByTestId('submit-application');
const hint = (page: Page) => page.getByTestId('submit-blocked-hint');

test.describe('F2-3 / F3-6 · «Илгээх» нь дутуу эсвэл хуучирсан алхамтай үед хаалттай', () => {
  test('шинэ хүсэлт (0 алхам): товч идэвхгүй, дутуу алхмуудыг нэрлэнэ, дарсан ч баталгаажуулалт гарахгүй', async ({ page }) => {
    const { api, guard, install } = await setup(page, () => detail());
    await install();
    await page.goto(`/los/loan-application/${ID}/score`);

    await expect(submit(page)).toBeDisabled();
    await expect(hint(page)).toContainText('Заавал бүрдэх алхам дутуу:');
    for (const name of ['Харилцагч', 'Лавлагаа', 'Орлого', 'Зээлийн мэдээлэл', 'Барьцаа', 'Эргэн төлөлтийн хуваарь', 'Тооцоолол']) await expect(hint(page)).toContainText(`${name} (Бүрдээгүй)`);
    await expect(submit(page)).toHaveAttribute('aria-describedby', 'submit-blocked-hint');
    await submit(page).click({ force: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.callsTo('POST', `/applications/${ID}/transition`)).toHaveLength(0);
    expectClean(guard, api);
  });

  test('буцаасан хүсэлт: ЭТХ ба тооцоолол хуучирсан → товч идэвхгүй, зөвхөн тэр хоёрыг «Дахин шалгах» гэж нэрлэнэ', async ({ page }) => {
    const done = REQUIRED.filter((k) => k !== 'installment' && k !== 'score');
    const { api, guard, install } = await setup(page, () => detail({ status: 'RETURNED', done, stale: ['installment', 'score'] }));
    await install();
    await page.goto(`/los/loan-application/${ID}/score`);

    await expect(submit(page)).toBeDisabled();
    await expect(hint(page)).toContainText('Эргэн төлөлтийн хуваарь (Дахин шалгах)');
    await expect(hint(page)).toContainText('Тооцоолол (Дахин шалгах)');
    await expect(hint(page)).not.toContainText('Харилцагч');
    expectClean(guard, api);
  });

  test('бүх заавал алхам бүрдсэн: товч идэвхтэй, сануулга байхгүй, батлахад POST transition', async ({ page }) => {
    let current = detail({ done: REQUIRED });
    const { api, guard, install } = await setup(page, () => current);
    api.post(`/applications/${ID}/transition`, ({ body }) => {
      expect(TransitionRequest.parse(body)).toEqual({ to: 'SUBMITTED' });
      current = ApplicationDetail.parse({ ...detail({ done: REQUIRED }), status: 'SUBMITTED', editable: false, transitions: [{ to: 'IN_APPROVAL', allowed: false, blockedBy: [] }] });
      return { json: current };
    });
    await install();
    await page.goto(`/los/loan-application/${ID}/score`);

    await expect(submit(page)).toBeEnabled();
    await expect(hint(page)).toHaveCount(0);
    await submit(page).click();
    await page.getByRole('button', { name: 'Илгээх' }).last().click();
    await expect(page.getByTestId('app-status')).toHaveText('Илгээсэн');
    expect(api.callsTo('POST', `/applications/${ID}/transition`)).toHaveLength(1);
    expectClean(guard, api);
  });
});

test.describe('F2-27 · баримт нэмэх/хасах → хүсэлтийн query шинэчлэгдэж зүүн самбар хоцрохгүй', () => {
  test('заавал баримт хавсаргахад «Баримт бичиг» бүрдэнэ (тоолуур, Илгээх), хасахад буцаж «Бүрдээгүй» болно', async ({ page }) => {
    const world = newDocWorld({ rows: [makeRow({ key: 'income_proof', name: 'Орлогын тодорхойлолт', required: true })], borrowers: [] });
    const required: StepKey[] = ['document'];
    const docDone = () => world.rows.filter((r) => r.required).every((r) => r.satisfied);
    const { api, guard, install } = await setup(page, () => detail({ required, done: docDone() ? ['document'] : [] }));
    installDocumentsApi(api, world);
    await install();
    await page.goto(`/los/loan-application/${ID}/document`);

    await expect(page.getByTestId('step-document')).toHaveAttribute('data-status', 'PENDING');
    await expect(page.getByTestId('counter-stage1')).toHaveText('Бүрдсэн: 0/9');
    await expect(submit(page)).toBeDisabled();

    await page.locator('[data-testid="checklist-row"][data-key="income_proof"]').getByRole('button', { name: 'Файл хавсаргах: Орлогын тодорхойлолт' }).click();
    const modal = page.getByRole('dialog', { name: 'Баримт хавсаргах: Орлогын тодорхойлолт' });
    await modal.locator('input[type=file]').setInputFiles({ name: 'income.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 DEMO') });
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal).toBeHidden();

    await expect(page.getByTestId('document-step-state')).toHaveText('Алхам бүрдсэн');
    await expect(page.getByTestId('step-document')).toHaveAttribute('data-status', 'COMPLETED');
    await expect(page.getByTestId('counter-stage1')).toHaveText('Бүрдсэн: 1/9');
    await expect(submit(page)).toBeEnabled();

    await page.locator('[data-testid="checklist-row"][data-key="income_proof"]').getByRole('button', { name: 'Хасах: income.pdf' }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Хасах', exact: true }).click();
    await expect(page.getByTestId('document-step-state')).toHaveText('Алхам дутуу');
    await expect(page.getByTestId('step-document')).toHaveAttribute('data-status', 'PENDING');
    await expect(page.getByTestId('counter-stage1')).toHaveText('Бүрдсэн: 0/9');
    await expect(submit(page)).toBeDisabled();
    expectClean(guard, api);
  });
});

const scheduleBody = (isStale: boolean) => ScheduleResponse.parse({
  editable: true,
  schedule: {
    id: 's1', generatedAt: AT, isStale,
    params: { startDate: '2026-11-05', firstPaymentDate: '2026-12-05', endDate: '2027-01-05', type: 'ANNUITY', graceMonths: 0, dayCount: '30/360', principal: 5_000_000, annualRate: 24, termMonths: 2, currency: 'MNT' },
    summary: { installments: 2, totalPrincipal: 5_000_000, totalInterest: 100_000, totalPayment: 5_100_000, firstDueDate: '2026-12-05', endDate: '2027-01-05' },
    rows: [
      { seq: 1, dueDate: '2026-12-05', days: 30, disbursement: 0, principal: 2_500_000, interest: 50_000, total: 2_550_000, balance: 2_500_000 },
      { seq: 2, dueDate: '2027-01-05', days: 30, disbursement: 0, principal: 2_500_000, interest: 50_000, total: 2_550_000, balance: 0 },
    ],
  },
});

test.describe('F3-7 · хуучирсан ЭТХ нь одоогийнх мэт харагдахгүй', () => {
  for (const [stale, tag, opacity] of [[true, 'Хуучирсан', '0.55'], [false, 'Хадгалсан', '1']] as const) {
    test(`isStale=${stale}: «${tag}» шошго, хүснэгтийн opacity ${opacity}`, async ({ page }) => {
      const { api, guard, install } = await setup(page, () => detail({ done: ['loan'] }));
      api.get('/applications/:id/schedule', () => ({ json: scheduleBody(stale) }));
      await install();
      await page.goto(`/los/loan-application/${ID}/installment`);

      await expect(page.getByTestId('sched-table')).toBeVisible();
      const results = page.getByTestId('sched-results');
      await expect(results).toHaveAttribute('data-stale', String(stale));
      await expect(results).toHaveCSS('opacity', opacity);
      await expect(page.getByTestId('sched-status-tag')).toHaveText(tag);
      if (stale) await expect(page.getByText('Хадгалсан', { exact: true })).toHaveCount(0);
      expectClean(guard, api);
    });
  }
});

test.describe('F3-8 · хуучирсан тооцооллын тоо нь одоогийнх мэт харагдахгүй', () => {
  for (const stale of [true, false]) {
    test(`isStale=${stale}: «Шууд үр дүн» ба харьцуулалт ${stale ? 'саарал, «Хуучирсан»' : 'хэвийн'}`, async ({ page }) => {
      const { api, guard, install } = await setup(page, () => detail({ done: ['loan'] }));
      api.get('/applications/:id/score', () => ({ json: makeOverview({ calculation: makeCalculation({ isStale: stale, staleReason: stale ? 'Зээлийн дүн өөрчлөгдсөн' : null }) }) }));
      await install();
      await page.goto(`/los/loan-application/${ID}/score`);

      await expect(page.getByRole('heading', { name: 'Тооцоолол', level: 4 })).toBeVisible();
      const live = page.getByTestId('score-live');
      const results = page.getByTestId('score-results');
      await expect(live).toHaveAttribute('data-stale', String(stale));
      await expect(results).toHaveAttribute('data-stale', String(stale));
      await expect(results).toHaveCSS('opacity', stale ? '0.55' : '1');
      if (stale) {
        await expect(live.getByText('Хуучирсан', { exact: true })).toBeVisible();
        await expect(live.locator('dl')).toHaveCSS('opacity', '0.55');
        await expect(page.getByTestId('score-results-stale-tag')).toHaveText('Хуучирсан');
      } else {
        await expect(live.getByText('Хуучирсан', { exact: true })).toHaveCount(0);
        await expect(page.getByTestId('score-results-stale-tag')).toHaveCount(0);
      }
      expectClean(guard, api);
    });
  }
});
