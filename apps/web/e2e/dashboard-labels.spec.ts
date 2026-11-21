import { expect, test, type Page } from '@playwright/test';
import { AgingBucket, ApplicationStatus, DashboardSummary, OrgDirectory } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F11-8: "Эргэн төлөлтийн цуглуулалт" картын шошго "Энэ сард цуглуулсан" гэж бодит ирсэн нийт мөнгийг
// мэт харагддаг ч код зөвхөн ТЭР САРД хугацаа болсон хуваарийн мөрт хуваарилагдсан төлбөрийг тоолдог
// (урьдчилж төлсөн мөнгө орохгүй) → менежер "энэ сард юу ч цуглаагүй" гэж андуурдаг. Шошго яг тоолсныг хэлнэ.
// API нийт хүлээн авсан дүн буцаадаггүй тул ийм карт нэмэхгүй.
const AT = '2026-11-21T03:00:00.000Z';
const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const SECTION_TITLE = 'Эргэн төлөлт (энэ сарын хуваарь)';

function makeSummary(collections: DashboardSummary['collections']): DashboardSummary {
  return DashboardSummary.parse({
    asOf: '2026-11-21', currency: 'MNT', scope: { branchId: null, officerId: null },
    applications: { byStatus: ApplicationStatus.map((status) => ({ status, count: 0, amount: 0 })), submittedThisMonth: 0, approvedThisMonth: 0, returnedThisMonth: 0, approvalRate: null, avgDecisionHours: null },
    disbursements: { thisMonthAmount: 0, lastMonthAmount: 0, thisMonthCount: 0, yearToDateAmount: 0, monthly: MONTHS.map((month) => ({ month, amount: 0, count: 0 })) },
    portfolio: { activeLoanCount: 0, outstandingPrincipal: 0, overdueAmount: 0, overdueLoanCount: 0, parRatio: null, aging: AgingBucket.map((bucket) => ({ bucket, loanCount: 0, principal: 0 })) },
    collections,
    topProducts: [],
    generatedAt: AT,
  });
}

async function setup(page: Page, collections: DashboardSummary['collections']) {
  const api = new MockApi('ADMIN');
  api.get('/directory', { json: OrgDirectory.parse({ branches: {}, users: {} }) });
  api.get('/reports/dashboard/summary', { json: makeSummary(collections) });
  await api.install(page);
  return { api, guard: guardConsole(page) };
}

test.describe('Dashboard: эргэн төлөлтийн картын шошго (F11-8)', () => {
  test('cards name exactly what is counted: payments applied to THIS month\'s schedule rows', async ({ page }) => {
    const { api, guard } = await setup(page, { dueThisMonth: 5_000_000, collectedThisMonth: 3_000_000, collectionRate: 0.6, dueNext7Days: 1_200_000 });
    await page.goto('/los/dashboard');

    await expect(page.getByRole('heading', { name: SECTION_TITLE })).toBeVisible();
    await expect(page.getByText('Энэ сарын хуваарьт төлөх', { exact: true })).toBeVisible();
    await expect(page.getByText('Энэ сарын хуваарьт төлөгдсөн', { exact: true })).toBeVisible();
    await expect(page.getByText('Хуваарийн биелэлт', { exact: true })).toBeVisible();
    await expect(page.getByText('3,000,000', { exact: false }).first()).toBeVisible();
    // Тодорхойлолт: урьдчилж төлсөн дүн энд ордоггүй гэдгийг хэрэглэгчид хэлнэ.
    await expect(page.getByText(/урьдчилж төлсөн дүн орохгүй/).first()).toBeVisible();
    expectClean(guard, api);
  });

  test('the misleading wording is gone: no "collected this month" and no "collection rate"', async ({ page }) => {
    const { api, guard } = await setup(page, { dueThisMonth: 0, collectedThisMonth: 0, collectionRate: null, dueNext7Days: 0 });
    await page.goto('/los/dashboard');
    await expect(page.getByText('Энэ сарын хуваарьт төлөгдсөн', { exact: true })).toBeVisible();

    await expect(page.getByText('Энэ сард цуглуулсан')).toHaveCount(0);
    await expect(page.getByText('Цуглуулалтын хувь')).toHaveCount(0);
    await expect(page.getByText('Эргэн төлөлтийн цуглуулалт')).toHaveCount(0);
    expectClean(guard, api);
  });
});
