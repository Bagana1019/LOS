import { expect, test, type Page } from '@playwright/test';
import { ApplicationListResponse, ApplicationStatus, OrgDirectory } from '@los/contracts';
import { MockApi } from './mock-api';

// F12-4 (давтан): "Миний батлах" таб дахь жагсаалтын 403 нь хүсэлтийн жагсаалттай адил "эрх байхгүй" гэж хэлж, хэзээ ч ажиллахгүй "Дахин оролдох" товчийг харуулахгүй.
// Бусад алдаа (500...) хуучнаар: ачаалж чадсангүй + Дахин оролдох.
const FORBIDDEN = { status: 403, json: { code: 'FORBIDDEN', message: 'Forbidden' } };
const BROKEN = { status: 500, json: { code: 'INTERNAL', message: 'boom' } };
const RETRY = 'Дахин оролдох';
const FORBIDDEN_TEXT = 'Танд батлах хүсэлтийн жагсаалтыг харах эрх байхгүй';
const LOAD_FAILED_TEXT = 'Хүсэлтийн жагсаалтыг ачаалж чадсангүй';
const SLOW = { timeout: 20_000 };

const counts = () => Object.fromEntries(ApplicationStatus.map((s) => [s, 0]));
const emptyList = ApplicationListResponse.parse({ items: [], total: 0, page: 1, pageSize: 20, counts: counts(), myApprovalCount: 0 });

async function openMine(page: Page, reply: { status: number; json: unknown }) {
  const api = new MockApi('APPROVER');
  await api.install(page);
  api.get('/applications', { json: emptyList });
  api.get('/directory', { json: OrgDirectory.parse({ branches: {}, users: {} }) });
  api.get('/approvals/mine', reply);
  await page.goto('/los/loan-application?status=MINE');
  return api;
}

test.describe('F12-4 · "Миний батлах" таб /los/loan-application?status=MINE', () => {
  test('403: "эрх байхгүй" мэдэгдэл харагдаж, "Дахин оролдох" товч, "ачаалж чадсангүй" байхгүй', async ({ page }) => {
    await openMine(page, FORBIDDEN);
    await expect(page.getByText(FORBIDDEN_TEXT)).toBeVisible();
    await expect(page.getByRole('button', { name: RETRY })).toHaveCount(0);
    await expect(page.getByText(LOAD_FAILED_TEXT)).toHaveCount(0);
  });

  test('500: хуучин мэдэгдэл + "Дахин оролдох" товч хэвээр, дарахад дахин ачаална', async ({ page }) => {
    const api = await openMine(page, BROKEN);
    await expect(page.getByText(LOAD_FAILED_TEXT)).toBeVisible(SLOW);
    await expect(page.getByText(FORBIDDEN_TEXT)).toHaveCount(0);
    const before = api.calls.filter((c) => c.path.endsWith('/approvals/mine')).length;
    api.get('/approvals/mine', { json: { items: [], total: 0 } });
    await page.getByRole('button', { name: RETRY }).click();
    await expect(page.getByText(LOAD_FAILED_TEXT)).toHaveCount(0, SLOW);
    expect(api.calls.filter((c) => c.path.endsWith('/approvals/mine')).length).toBeGreaterThan(before);
  });

  test('амжилттай ачаалахад алдааны мэдэгдэл байхгүй, хоосон жагсаалт', async ({ page }) => {
    await openMine(page, { status: 200, json: { items: [], total: 0 } });
    await expect(page.getByText('Таны батлах хүсэлт алга')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /ачаалж чадсангүй|эрх байхгүй/ })).toHaveCount(0);
  });
});
