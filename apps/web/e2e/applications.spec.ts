import { expect, test, type Page } from '@playwright/test';
import { ApplicationDetail, ApplicationListResponse, ApplicationStatus, StepKey, TransitionRequest, type ApplicationStepView, type UserRole } from '@los/contracts';
import { expectClean, expectNoHorizontalScroll } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Модуль 2: хүсэлтийн жагсаалт (9 таб), "Шинэ хүсэлт", wizard-ийн зүүн самбар (6/9 тоолуур, 2-р үе шат цоожтой), Илгээх. Gateway mock.
const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-02T03:00:00.000Z';
const STAGE2 = ['contract', 'official_documents', 'disburse'];
const REQUIRED = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'];

const steps = (done: string[]): ApplicationStepView[] => StepKey.map((stepKey, i) => ({
  stepKey, stage: STAGE2.includes(stepKey) ? 2 : 1, order: i + 1, status: STAGE2.includes(stepKey) ? 'LOCKED' : done.includes(stepKey) ? 'COMPLETED' : 'PENDING',
  required: REQUIRED.includes(stepKey), completedAt: done.includes(stepKey) ? AT : null, staleReason: null,
}));

function detail(done: string[], over: Record<string, unknown> = {}): ApplicationDetail {
  return ApplicationDetail.parse({
    id: ID, appNo: 'LA-2026-000001', branchId: 'b1', officerId: 'u1', contractNo: null, primaryBorrower: null, productId: null, productName: null, currency: 'MNT', amount: null, interestRate: null, termMonths: null,
    decidedAt: null, status: 'DRAFT', stepsDone: done.filter((d) => REQUIRED.includes(d)).length, stepsRequired: 7, createdAt: AT, officerNote: null, purpose: null, version: 1, source: 'WEB',
    submittedAt: null, approvedAt: null, returnedAt: null, steps: steps(done), stage1Completed: done.length, stage1Total: 9, editable: true,
    transitions: [{ to: 'SUBMITTED', allowed: true, blockedBy: REQUIRED.filter((r) => !done.includes(r)) }], ...over,
  });
}

const counts = () => Object.fromEntries(ApplicationStatus.map((s) => [s, s === 'DRAFT' ? 2 : 0]));
const listBody = (items: ApplicationDetail[]) => ApplicationListResponse.parse({ items, total: items.length, page: 1, pageSize: 20, counts: counts(), myApprovalCount: 0 });

async function setup(page: Page, role: UserRole = 'OFFICER') {
  const api = new MockApi(role);
  await api.install(page);
  return { api, guard: guardConsole(page) };
}

test('жагсаалт: 9 таб, тоолуур, мөр, "Шинэ хүсэлт" → үүсгээд wizard руу', async ({ page }) => {
  const { api, guard } = await setup(page);
  const created = detail(['client']);
  api.get('/applications', () => ({ json: listBody([detail([])]) }));
  api.post('/applications', ({ body }) => { expect(body).toEqual({}); return { status: 201, json: created }; });
  api.get(`/applications/${ID}`, () => ({ json: created }));
  await page.goto('/los/loan-application');
  await expect(page.getByRole('heading', { name: 'Зээлийн хүсэлт', level: 3 })).toBeVisible();
  for (const label of ['Шинэ', 'Илгээсэн', 'Батлах явцад', 'Батлагдсан', 'Буцаасан', 'Олгох', 'Идэвхтэй', 'Хаасан', 'Эхний үлдэгдэлтэй']) await expect(page.getByRole('tab', { name: new RegExp(`^${label}`) })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Шинэ/ })).toContainText('2');
  await expect(page.getByRole('row', { name: /LA-2026-000001/ })).toContainText('0/7 алхам');
  expect(api.callsTo('GET', '/applications')[0].search.get('status')).toBe('DRAFT');

  await page.getByTestId('create-application').click();
  await page.getByRole('button', { name: 'Үүсгэх' }).click();
  await expect(page).toHaveURL(new RegExp(`/los/loan-application/${ID}/inquiry$`)); // эхний бүрдээгүй алхам
  await expect(page.getByTestId('app-no')).toHaveText('LA-2026-000001');
  expectClean(guard, api);
});

test('wizard: 1/9 тоолуур, 2-р үе шат цоожтой, Илгээх (G1) → POST transition', async ({ page }) => {
  const { api, guard } = await setup(page);
  let current = detail(REQUIRED);
  api.get(`/applications/${ID}`, () => ({ json: current }));
  api.post(`/applications/${ID}/transition`, ({ body }) => {
    expect(TransitionRequest.parse(body)).toEqual({ to: 'SUBMITTED' });
    current = detail(REQUIRED, { status: 'SUBMITTED', editable: false, transitions: [{ to: 'IN_APPROVAL', allowed: false, blockedBy: [] }] });
    return { json: current };
  });
  await page.goto(`/los/loan-application/${ID}/inquiry`);
  await expect(page.getByTestId('counter-stage1')).toHaveText('Бүрдсэн: 7/9');
  for (const k of STAGE2) await expect(page.getByTestId(`step-${k}`)).toBeDisabled();
  await expect(page.getByTestId('step-client')).toHaveAttribute('data-status', 'COMPLETED');
  await expect(page.getByTestId('step-inquiry')).toHaveAttribute('aria-current', 'step');
  await expectNoHorizontalScroll(page);

  await page.getByTestId('submit-application').click();
  await page.getByRole('button', { name: 'Илгээх' }).last().click();
  await expect(page.getByTestId('app-status')).toHaveText('Илгээсэн');
  await expect(page.getByTestId('submit-application')).toHaveCount(0);
  expect(api.callsTo('POST', `/applications/${ID}/transition`)).toHaveLength(1);
  expectClean(guard, api);
});

test('хандах эрхгүй хүсэлт (403) → мэдэгдэл', async ({ page }) => {
  const { api } = await setup(page);
  api.get(`/applications/${ID}`, { status: 403, json: { code: 'FORBIDDEN', message: 'x' } });
  await page.goto(`/los/loan-application/${ID}/client`);
  await expect(page.locator('.ant-alert')).toContainText('олдсонгүй эсвэл хандах эрхгүй');
});
