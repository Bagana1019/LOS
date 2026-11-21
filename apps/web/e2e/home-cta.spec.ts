import { expect, test, type Page } from '@playwright/test';
import { ApplicationDetail, ApplicationListResponse, ApplicationStatus, BorrowerListResponse, StepKey, type UserRole } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F0-2: нүүр хуудас дээр дүрт тохирсон үндсэн үйлдэл (CTA) + "дараагийн алхам" зөвлөмж. Gateway mock.
const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-02T03:00:00.000Z';

const created = ApplicationDetail.parse({
  id: ID, appNo: 'LA-2026-000001', branchId: 'b1', officerId: 'u1', contractNo: null, primaryBorrower: null, productId: null, productName: null, currency: 'MNT', amount: null, interestRate: null, termMonths: null,
  decidedAt: null, status: 'DRAFT', stepsDone: 0, stepsRequired: 7, createdAt: AT, officerNote: null, purpose: null, version: 1, source: 'WEB',
  submittedAt: null, approvedAt: null, returnedAt: null,
  steps: StepKey.map((stepKey, i) => ({ stepKey, stage: 1, order: i + 1, status: 'PENDING', required: true, completedAt: null, staleReason: null })),
  stage1Completed: 0, stage1Total: 9, editable: true, transitions: [],
});

// Wizard-ийн эхний алхам (харилцагч) хоосон жагсаалт асууна; энэ spec wizard-ийг шалгахгүй.
const noBorrowers = BorrowerListResponse.parse({
  items: [], warnings: [],
  summary: { primaryCount: 0, coBorrowerCount: 0, guarantorCount: 0, pledgorCount: 0, clientStepComplete: false, primaryLiabilityShare: null, incomeContributorCustomerIds: [], guaranteeCoverageRatio: null, limits: { maxCoBorrowers: 3, maxGuarantors: 3 }, editable: true },
});

// CreateApplicationModal (энэ PR-д өөрчлөгдөөгүй) antd-ийн хуучирсан `destroyOnClose`-ийг ашигладаг: antd 5.29 нь modal mount хийгдэхэд анхааруулна (жагсаалтын хуудсанд ч адил).
// Зөвхөн энэ нэг мэдэгдэх анхааруулгыг чөлөөлж, бусад консолын алдаа/mock-гүй дуудлагыг хэвээр барина.
const KNOWN_ANTD_DEPRECATION = /`destroyOnClose` is deprecated/;
const expectCleanBesidesModalDeprecation = (guard: { problems: string[] }, api: MockApi) =>
  expectClean({ problems: guard.problems.filter((p) => !KNOWN_ANTD_DEPRECATION.test(p)) }, api);

// `next dev` нь замыг анх удаа нээхэд compile хийдэг тул client-side шилжилтийн URL-г удаан хүлээнэ.
const COLD_COMPILE_MS = 45_000;

async function openHome(page: Page, role: UserRole) {
  const api = new MockApi(role);
  await api.install(page);
  const guard = guardConsole(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible();
  return { api, guard };
}

const newApplicationButton = (page: Page) => page.getByRole('button', { name: 'Шинэ хүсэлт' });

test('ЗЭЗ: нүүр дээр "Шинэ хүсэлт" үндсэн товч + дараагийн алхмын зөвлөмж', async ({ page }) => {
  const { api, guard } = await openHome(page, 'OFFICER');
  await expect(newApplicationButton(page)).toBeVisible();
  await expect(page.getByTestId('home-next-step')).toContainText('Эхлээд ноорог үүсгэнэ');
  expectCleanBesidesModalDeprecation(guard, api);
});

test('ЗЭЗ: "Шинэ хүсэлт" → үүсгээд wizard руу (жагсаалтаар тойрохгүй)', async ({ page }) => {
  test.slow();
  const { api, guard } = await openHome(page, 'OFFICER');
  api.post('/applications', ({ body }) => { expect(body).toEqual({}); return { status: 201, json: created }; });
  api.get(`/applications/${ID}`, () => ({ json: created }));
  api.get(`/applications/${ID}/borrowers`, () => ({ json: noBorrowers }));
  await newApplicationButton(page).click();
  await page.getByRole('button', { name: 'Үүсгэх' }).click();
  await expect(page).toHaveURL(new RegExp(`/los/loan-application/${ID}/`), { timeout: COLD_COMPILE_MS });
  expect(api.callsTo('POST', '/applications')).toHaveLength(1);
  expect(api.callsTo('GET', '/applications')).toHaveLength(0); // жагсаалтаар тойроогүй
  expectCleanBesidesModalDeprecation(guard, api);
});

for (const role of ['APPROVER', 'BRANCH_MANAGER'] as const) {
  test(`${role}: "Шинэ хүсэлт" байхгүй, оронд нь "Миний батлах" таб руу холбоос`, async ({ page }) => {
    const { api, guard } = await openHome(page, role);
    await expect(newApplicationButton(page)).toHaveCount(0);
    const link = page.getByTestId('home-next-step').getByRole('link', { name: 'Батлах хүсэлтүүд рүү очих' });
    await expect(link).toHaveAttribute('href', '/los/loan-application?status=MINE');
    expectClean(guard, api);
  });
}

test('APPROVER: холбоос дээр дарахад "Миний батлах" таб нээгдэнэ', async ({ page }) => {
  test.slow();
  const { api } = await openHome(page, 'APPROVER');
  const counts = Object.fromEntries(ApplicationStatus.map((s) => [s, 0]));
  api.get('/applications', () => ({ json: ApplicationListResponse.parse({ items: [], total: 0, page: 1, pageSize: 20, counts, myApprovalCount: 0 }) }));
  api.get('/approvals/mine', () => ({ json: { items: [], total: 0, page: 1, pageSize: 20 } }));
  await page.getByTestId('home-next-step').getByRole('link', { name: 'Батлах хүсэлтүүд рүү очих' }).click();
  await expect(page).toHaveURL(/\/los\/loan-application\?status=MINE$/, { timeout: COLD_COMPILE_MS });
});

for (const role of ['ADMIN', 'COMPLIANCE'] as const) {
  test(`${role}: үндсэн үйлдэл байхгүй — "Шинэ хүсэлт"-гүй, хоосон "дараагийн алхам" самбаргүй`, async ({ page }) => {
    const { api, guard } = await openHome(page, role);
    await expect(newApplicationButton(page)).toHaveCount(0);
    await expect(page.getByTestId('home-next-step')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Хандах боломжтой хэсгүүд' })).toBeVisible(); // хуучин товчлол хэвээр
    expectClean(guard, api);
  });
}
