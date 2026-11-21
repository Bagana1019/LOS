import { expect, test, type Page } from '@playwright/test';
import { ApplicationListResponse, ApplicationStatus, OrgDirectory, type UserRole } from '@los/contracts';
import { MockApi } from './mock-api';

// F12-4: жагсаалтын API 403 өгөхөд "ачаалж чадсангүй + Дахин оролдох" биш, ойлгомжтой "эрх байхгүй" (давтан оролдох хэзээ ч ажиллахгүй тул товчгүй).
// Бусад алдаа (500...) хуучнаар: ачаалж чадсангүй + Дахин оролдох.
// Дүр нь клиент талын хаалгыг (application:read) давдаг тул хуудас нээгдэнэ; харин API нь 403 өгнө (эрхийн map ↔ @Roles зөрүү, дүр сессийн дундуур өөрчлөгдсөн гэх мэт).
const FORBIDDEN = { status: 403, json: { code: 'FORBIDDEN', message: 'Forbidden' } };
const BROKEN = { status: 500, json: { code: 'INTERNAL', message: 'boom' } };
const RETRY = 'Дахин оролдох';

const counts = () => Object.fromEntries(ApplicationStatus.map((s) => [s, 0]));
const emptyList = ApplicationListResponse.parse({ items: [], total: 0, page: 1, pageSize: 20, counts: counts(), myApprovalCount: 0 });

async function open(page: Page, path: string, reply: { status: number; json: unknown }, role: UserRole = 'OFFICER') {
  const api = new MockApi(role);
  await api.install(page);
  api.get('/applications', reply);
  api.get('/directory', { json: OrgDirectory.parse({ branches: {}, users: {} }) });
  await page.goto(path);
  return api;
}

test.describe('F12-4 · хүсэлтийн жагсаалт /los/loan-application', () => {
  test('403: "эрх байхгүй" мэдэгдэл харагдаж, "Дахин оролдох" товч, "ачаалж чадсангүй" байхгүй', async ({ page }) => {
    await open(page, '/los/loan-application', FORBIDDEN);
    await expect(page.getByText('Танд хүсэлтийн жагсаалтыг харах эрх байхгүй')).toBeVisible();
    await expect(page.getByRole('button', { name: RETRY })).toHaveCount(0);
    await expect(page.getByText('Хүсэлтийн жагсаалтыг ачаалж чадсангүй')).toHaveCount(0);
  });

  test('500: хуучин мэдэгдэл + "Дахин оролдох" товч хэвээр', async ({ page }) => {
    await open(page, '/los/loan-application', BROKEN);
    await expect(page.getByText('Хүсэлтийн жагсаалтыг ачаалж чадсангүй')).toBeVisible();
    await expect(page.getByRole('button', { name: RETRY })).toBeVisible();
    await expect(page.getByText('Танд хүсэлтийн жагсаалтыг харах эрх байхгүй')).toHaveCount(0);
  });

  test('жагсаалт амжилттай ачаалахад алдааны мэдэгдэл байхгүй', async ({ page }) => {
    await open(page, '/los/loan-application', { status: 200, json: emptyList });
    await expect(page.getByText('Энэ төлөвт хүсэлт алга')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /ачаалж чадсангүй|эрх байхгүй/ })).toHaveCount(0);
  });
});

test.describe('F12-4 · зээлийн жагсаалт /los/loan/list', () => {
  test('403: "эрх байхгүй" мэдэгдэл харагдаж, "Дахин оролдох" товч, "ачаалж чадсангүй" байхгүй', async ({ page }) => {
    await open(page, '/los/loan/list', FORBIDDEN);
    await expect(page.getByText('Танд зээлийн жагсаалтыг харах эрх байхгүй')).toBeVisible();
    await expect(page.getByRole('button', { name: RETRY })).toHaveCount(0);
    await expect(page.getByText('Зээлийн жагсаалтыг ачаалж чадсангүй')).toHaveCount(0);
  });

  test('500: хуучин мэдэгдэл + "Дахин оролдох" товч хэвээр', async ({ page }) => {
    await open(page, '/los/loan/list', BROKEN);
    await expect(page.getByText('Зээлийн жагсаалтыг ачаалж чадсангүй')).toBeVisible();
    await expect(page.getByRole('button', { name: RETRY })).toBeVisible();
    await expect(page.getByText('Танд зээлийн жагсаалтыг харах эрх байхгүй')).toHaveCount(0);
  });
});
