import { expect, test, type Page } from '@playwright/test';
import type { AdminBranchDto, AdminUserDto } from '@los/contracts';
import { expectClean, expectNoHorizontalScroll, setupBackOffice } from './helpers';
import { PASSWORD, mockGateway } from './mock-gateway';
import { guardConsole } from './mock-api';
import type { MockApi } from './mock-api';

// FR-13 · /settings/users, /settings/branches: нэмэх, идэвхгүй болгох, түр нууц үг; түр нууц үгтэй хэрэглэгчийн заавал солих дэлгэц.

const HEAD = '00000000-0000-4000-8000-000000000a01';
const user = (o: Partial<AdminUserDto> & { id: string; username: string }): AdminUserDto => ({
  fullName: `${o.username} Бат`, roles: ['OFFICER'], branchId: HEAD, isActive: true, lastLoginAt: null, email: null, phone: null, mustChangePassword: false, ...o,
});
const branch = (o: Partial<AdminBranchDto> & { id: string; code: string }): AdminBranchDto => ({ name: `Салбар ${o.code}`, isActive: true, activeUserCount: 1, ...o });

function installAdminApi(api: MockApi) {
  const state = {
    users: [user({ id: 'id-officer.a', username: 'officer.a', roles: ['ADMIN'], branchId: null }), user({ id: 'u-2', username: 'officer.b' }), user({ id: 'u-3', username: 'old.user', isActive: false })],
    branches: [branch({ id: HEAD, code: '100', name: 'Төв салбар' }), branch({ id: 'b-2', code: '200', name: 'Баянзүрх', activeUserCount: 0 })],
  };
  api.get('/admin/users', () => ({ json: state.users }));
  api.get('/admin/branches', () => ({ json: state.branches }));
  api.get('/settings', () => ({ json: [] }));
  api.get('/maker-checker/requests', () => ({ json: { items: [], total: 0, page: 1, pageSize: 20 } }));
  api.post('/admin/users', ({ body }) => {
    const b = body as { username: string; fullName: string; roles: string[]; branchId: string | null };
    const created = user({ id: 'u-new', username: b.username, fullName: b.fullName, roles: b.roles, branchId: b.branchId, mustChangePassword: true });
    state.users.push(created);
    return { status: 201, json: { user: created, temporaryPassword: 'Tmp9xKq2LmNp4Rvw' } };
  });
  api.post('/admin/users/:id/deactivate', ({ params }) => {
    const u = state.users.find((x) => x.id === params.id)!;
    u.isActive = false;
    return { json: u };
  });
  api.post('/admin/branches', ({ body }) => {
    const b = body as { code: string; name: string };
    const created = branch({ id: 'b-new', code: b.code, name: b.name, activeUserCount: 0 });
    state.branches.push(created);
    return { status: 201, json: created };
  });
  api.post('/admin/branches/:id/deactivate', ({ params }) => {
    if (params.id === HEAD) return { status: 422, json: { code: 'BRANCH_HAS_ACTIVE_USERS', message: 'Салбарт 1 идэвхтэй хэрэглэгч байна. Эхлээд өөр салбарт шилжүүлнэ үү' } };
    const b = state.branches.find((x) => x.id === params.id)!;
    b.isActive = false;
    return { json: b };
  });
  return state;
}

async function pickRole(page: Page, role: string) {
  await page.locator('.ant-modal .ant-select').first().click();
  await page.locator('.ant-select-item-option', { hasText: role }).click();
  await page.keyboard.press('Escape');
}

test.describe('Хэрэглэгчийн удирдлага', () => {
  test('жагсаалт, шүүлтүүр, өөрийн мөрөнд идэвхгүй болгох/нууц үг шинэчлэх хаалттай', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installAdminApi(api);
    await page.goto('/settings/users');
    const table = page.getByRole('table', { name: 'Хэрэглэгч' });
    await expect(table).toContainText('officer.b');
    await expect(table).toContainText('old.user');
    await page.locator('.ant-segmented-item', { hasText: 'Идэвхгүй' }).click();
    await expect(table).not.toContainText('officer.b');
    await expect(table).toContainText('old.user');
    await page.locator('.ant-segmented-item', { hasText: 'Бүгд' }).click();
    await page.getByPlaceholder('Нэр, нэвтрэх нэрээр хайх').fill('officer.b');
    await expect(table).not.toContainText('old.user');

    await page.getByPlaceholder('Нэр, нэвтрэх нэрээр хайх').fill('officer.a');
    const self = table.locator('tr', { hasText: 'officer.a' });
    await expect(self.getByRole('button', { name: 'Идэвхгүй болгох' })).toBeDisabled();
    await expect(self.getByRole('button', { name: 'Нууц үг шинэчлэх' })).toBeDisabled();
    await expectNoHorizontalScroll(page);
    expectClean(guard, api);
  });

  test('хэрэглэгч нэмэх → түр нууц үг нэг удаа үзүүлнэ; идэвхгүй болгох', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installAdminApi(api);
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'Хэрэглэгч нэмэх' }).click();
    await page.locator('#username').fill('New.Person');
    await page.locator('#fullName').fill('Шинэ Хүн');
    await page.locator('.ant-modal .ant-select').nth(1).click();
    await page.locator('.ant-select-item-option', { hasText: 'Төв салбар' }).click();
    await page.getByRole('button', { name: 'Хадгалах' }).click();

    await expect(page.getByRole('dialog', { name: 'Түр нууц үг' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Түр нууц үг' })).toHaveValue('Tmp9xKq2LmNp4Rvw');
    expect(api.lastCall('POST', '/admin/users')!.body).toMatchObject({ username: 'new.person', fullName: 'Шинэ Хүн', roles: ['OFFICER'], branchId: HEAD });
    await page.getByRole('button', { name: 'Хадгалсан, хаах' }).click();
    await expect(page.getByRole('dialog', { name: 'Түр нууц үг' })).toBeHidden();
    await expect(page.getByRole('table', { name: 'Хэрэглэгч' })).toContainText('new.person');
    await expect(page.getByText('Tmp9xKq2LmNp4Rvw')).toHaveCount(0); // нууц үг дахин харагдахгүй

    const row = page.getByRole('table', { name: 'Хэрэглэгч' }).locator('tr', { hasText: 'officer.b' });
    await row.getByRole('button', { name: 'Идэвхгүй болгох' }).click();
    await page.getByRole('button', { name: 'Идэвхгүй болгох' }).last().click();
    await expect.poll(() => api.callsTo('POST', '/admin/users/:id/deactivate').length).toBe(1);
    expectClean(guard, api);
  });
});

test.describe('Салбарын удирдлага', () => {
  test('салбар нэмэх, идэвхтэй хэрэглэгчтэй салбарыг идэвхгүй болгоход серверийн алдаа харагдана', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installAdminApi(api);
    await page.goto('/settings/branches');
    const table = page.getByRole('table', { name: 'Салбарын жагсаалт' });
    await expect(table).toContainText('Төв салбар');

    await page.getByRole('button', { name: 'Салбар нэмэх' }).click();
    await page.locator('#code').fill('uld');
    await page.locator('#name').fill('Улаанбаатар 2');
    await page.getByRole('button', { name: 'Хадгалах' }).click();
    await expect(table).toContainText('Улаанбаатар 2');
    expect(api.lastCall('POST', '/admin/branches')!.body).toEqual({ code: 'ULD', name: 'Улаанбаатар 2' });

    await table.locator('tr', { hasText: 'Төв салбар' }).getByRole('button', { name: 'Идэвхгүй болгох' }).click();
    await page.getByRole('button', { name: 'Идэвхгүй болгох' }).last().click();
    await expect(page.getByText('Эхлээд өөр салбарт шилжүүлнэ үү')).toBeVisible();
    await expect(table.locator('tr', { hasText: 'Төв салбар' })).toContainText('Идэвхтэй');
    await expectNoHorizontalScroll(page);
    expectClean(guard, api);
  });
});

test('түр нууц үгтэй хэрэглэгч нууц үгээ солтол shell-д орохгүй, амжилттай бол нэвтрэх дэлгэц', async ({ page }) => {
  const gw = await mockGateway(page, { signedIn: true, role: 'OFFICER', authOnly: false, mustChangePassword: true });
  const guard = guardConsole(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Нууц үгээ солино уу' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);

  await page.getByLabel('Одоогийн (түр) нууц үг').fill(PASSWORD);
  await page.getByLabel('Шинэ нууц үг', { exact: true }).fill('short');
  await expect(page.getByRole('button', { name: 'Нууц үг солих' })).toBeDisabled();
  await page.getByLabel('Шинэ нууц үг', { exact: true }).fill('NewPassw0rd-ok');
  await page.getByLabel('Шинэ нууц үг (давтах)').fill('NewPassw0rd-no');
  await expect(page.getByText('Нууц үг таарахгүй байна')).toBeVisible();
  await page.getByLabel('Шинэ нууц үг (давтах)').fill('NewPassw0rd-ok');
  await page.getByRole('button', { name: 'Нууц үг солих' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(gw.requests).toContain('POST /auth/change-password');
  expect(guard.problems).toEqual([]);
});
