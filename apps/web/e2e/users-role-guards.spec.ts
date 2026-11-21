import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AdminUserDto } from '@los/contracts';
import { expectClean, setupBackOffice } from './helpers';
import type { MockApi } from './mock-api';

// F9-19 · /settings/users: дүрийн хамгаалалт (хос хаах, өөртөө нэмэхгүй), эрх өсгөх үед баталгаажуулах цонх, серверийн 422 маягт дотор.
// Дүрмийг сервер (gateway) шийднэ; web нь `@los/contracts`-ийн дүрмийг тусган хэрэглэгчийг эртхэн сануулна.

const HEAD = '00000000-0000-4000-8000-000000000a01';
const SELF_ID = 'id-officer.a'; // setupBackOffice-ийн нэвтэрсэн хэрэглэгч (ADMIN)
const user = (o: Partial<AdminUserDto> & { id: string; username: string }): AdminUserDto => ({
  fullName: `${o.username} Бат`, roles: ['OFFICER'], branchId: HEAD, isActive: true, lastLoginAt: null, email: null, phone: null, mustChangePassword: false, ...o,
});

const SELF_REASON = 'Өөртөө дүр нэмэх боломжгүй: өөр админаар олгуулна';
const CONFIRM_TITLE = 'Өндөр эрх олгохыг баталгаажуулна уу';

function installApi(api: MockApi) {
  const state = {
    users: [
      user({ id: SELF_ID, username: 'officer.a', roles: ['ADMIN'], branchId: null }),
      user({ id: 'u-2', username: 'officer.b' }),
      user({ id: 'u-3', username: 'legacy.both', roles: ['OFFICER', 'APPROVER'] }),
    ],
    putError: null as { code: string; message: string } | null,
  };
  api.get('/admin/users', () => ({ json: state.users }));
  api.get('/admin/branches', () => ({ json: [{ id: HEAD, code: '100', name: 'Төв салбар', isActive: true, activeUserCount: 3 }] }));
  api.get('/settings', () => ({ json: [] }));
  api.get('/maker-checker/requests', () => ({ json: { items: [], total: 0, page: 1, pageSize: 20 } }));
  api.put('/admin/users/:id', ({ params, body }) => {
    if (state.putError) return { status: 422, json: state.putError };
    const b = body as Partial<AdminUserDto>;
    const u = state.users.find((x) => x.id === params.id)!;
    Object.assign(u, { fullName: b.fullName ?? u.fullName, roles: b.roles ?? u.roles, branchId: b.branchId ?? u.branchId });
    return { json: u };
  });
  api.post('/admin/users', ({ body }) => {
    const b = body as { username: string; fullName: string; roles: string[]; branchId: string | null };
    const created = user({ id: 'u-new', username: b.username, fullName: b.fullName, roles: b.roles, branchId: b.branchId, mustChangePassword: true });
    state.users.push(created);
    return { status: 201, json: { user: created, temporaryPassword: 'Tmp9xKq2LmNp4Rvw' } };
  });
  return state;
}

const rowOf = (page: Page, username: string): Locator => page.getByRole('table', { name: 'Хэрэглэгч' }).locator('tr', { hasText: username });
const editDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Хэрэглэгч засах' });
const createDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Шинэ хэрэглэгч' });
const confirmDialog = (page: Page): Locator => page.getByRole('dialog', { name: CONFIRM_TITLE });
const option = (page: Page, role: string): Locator => page.locator('.ant-select-item-option', { hasText: role });
const DISABLED = /ant-select-item-option-disabled/;

async function openRoles(dialog: Locator) {
  await dialog.locator('.ant-select').first().click();
}
/** Нээлттэй жагсаалтаас дүрийг сонгох/хасах (toggle), дараа нь жагсаалтыг хаана. */
async function toggleRole(page: Page, dialog: Locator, role: string) {
  await openRoles(dialog);
  await option(page, role).click();
  await page.keyboard.press('Escape');
}
async function editUser(page: Page, username: string): Promise<Locator> {
  await rowOf(page, username).getByRole('button', { name: 'Засах' }).click();
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('F9-19 · хэрэглэгчийн дүрийн хамгаалалт', () => {
  test('1. OFFICER сонгосон бол APPROVER хаагдаж шалтгаан бичигдэнэ (эсрэгээр нь мөн); хуучин хоёр дүртэй хэрэглэгчид юу ч хаагдахгүй', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installApi(api);
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'Хэрэглэгч нэмэх' }).click();
    const dialog = createDialog(page);
    await expect(dialog).toBeVisible();

    // шинэ хэрэглэгч анхдагчаар OFFICER
    await openRoles(dialog);
    await expect(option(page, 'APPROVER')).toHaveClass(DISABLED);
    await expect(option(page, 'OFFICER')).not.toHaveClass(DISABLED);
    await expect(option(page, 'ADMIN')).not.toHaveClass(DISABLED);
    await page.keyboard.press('Escape');
    await expect(dialog).toContainText('Батлагч (APPROVER) дүрийг Зээлийн эдийн засагч (OFFICER) дүртэй зэрэг олгохгүй');

    // OFFICER-ыг хасвал APPROVER нээгдэж, шалтгаан алга болно; APPROVER сонговол OFFICER хаагдана
    await toggleRole(page, dialog, 'OFFICER');
    await expect(dialog).not.toContainText('зэрэг олгохгүй');
    await toggleRole(page, dialog, 'APPROVER');
    await openRoles(dialog);
    await expect(option(page, 'OFFICER')).toHaveClass(DISABLED);
    await page.keyboard.press('Escape');
    await expect(dialog).toContainText('Зээлийн эдийн засагч (OFFICER) дүрийг Батлагч (APPROVER) дүртэй зэрэг олгохгүй');
    await dialog.getByRole('button', { name: 'Болих' }).click();
    await expect(dialog).toBeHidden();

    // хуучин OFFICER+APPROVER хэрэглэгч: хаагдсан зүйл байхгүй, нэгийг нь хасаад хадгалж болно (баталгаажуулах цонхгүй)
    const legacy = await editUser(page, 'legacy.both');
    await openRoles(legacy);
    await expect(option(page, 'APPROVER')).not.toHaveClass(DISABLED);
    await expect(option(page, 'OFFICER')).not.toHaveClass(DISABLED);
    await page.keyboard.press('Escape');
    await expect(legacy).not.toContainText('зэрэг олгохгүй');
    await toggleRole(page, legacy, 'OFFICER');
    await legacy.getByRole('button', { name: 'Хадгалах' }).click();
    await expect.poll(() => api.callsTo('PUT', '/admin/users/:id').length).toBe(1);
    expect(api.lastCall('PUT', '/admin/users/:id')!.body).toMatchObject({ roles: ['APPROVER'] });
    await expect(confirmDialog(page)).toHaveCount(0);
    expectClean(guard, api);
  });

  test('2. өөрийн бүртгэлийг засахад өөрт байхгүй дүр хаагдана, байгаа дүр нь засагдана; өөр хэрэглэгчид энэ хориг үйлчлэхгүй', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installApi(api);
    await page.goto('/settings/users');

    const self = await editUser(page, 'officer.a');
    await openRoles(self);
    for (const r of ['APPROVER', 'BRANCH_MANAGER', 'OFFICER', 'COMPLIANCE']) await expect(option(page, r)).toHaveClass(DISABLED);
    await expect(option(page, 'ADMIN')).not.toHaveClass(DISABLED);
    await page.keyboard.press('Escape');
    await expect(self).toContainText(SELF_REASON);
    await self.getByRole('button', { name: 'Болих' }).click();
    await expect(self).toBeHidden();

    const other = await editUser(page, 'officer.b');
    await openRoles(other);
    await expect(option(page, 'ADMIN')).not.toHaveClass(DISABLED);
    await expect(option(page, 'COMPLIANCE')).not.toHaveClass(DISABLED);
    await page.keyboard.press('Escape');
    await expect(other).not.toContainText(SELF_REASON);
    expectClean(guard, api);
  });

  test('3a. эрх өсгөх дүр нэмэхэд баталгаажуулах цонх гарч, баталгаажуулахаас өмнө PUT явахгүй; Болих бол маягт нээлттэй үлдэнэ', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installApi(api);
    await page.goto('/settings/users');

    const dialog = await editUser(page, 'officer.b');
    await toggleRole(page, dialog, 'ADMIN');
    await dialog.getByRole('button', { name: 'Хадгалах' }).click();

    const confirm = confirmDialog(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('officer.b Бат');
    await expect(confirm).toContainText('officer.b');
    await expect(confirm).toContainText('Админ (ADMIN)');
    await expect(confirm).not.toContainText('Зээлийн эдийн засагч'); // зөвхөн шинээр нэмэгдэх эрх өсгөх дүр
    await expect(confirm).toContainText('нэн даруй');
    await expect(confirm).toContainText('аудит');
    expect(api.callsTo('PUT', '/admin/users/:id')).toHaveLength(0);

    await confirm.getByRole('button', { name: 'Болих' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();
    expect(api.callsTo('PUT', '/admin/users/:id')).toHaveLength(0);

    await dialog.getByRole('button', { name: 'Хадгалах' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Олгох' }).click();
    await expect.poll(() => api.callsTo('PUT', '/admin/users/:id').length).toBe(1);
    expect(api.lastCall('PUT', '/admin/users/:id')!.body).toMatchObject({ roles: expect.arrayContaining(['ADMIN', 'OFFICER']) });
    await expect(dialog).toBeHidden();
    expectClean(guard, api);
  });

  test('3b. эрх өсгөхгүй өөрчлөлтөд (профайл засах) цонх гарахгүй; шинэ хэрэглэгчид эрх өсгөх дүр сонговол гарна', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installApi(api);
    await page.goto('/settings/users');

    const profile = await editUser(page, 'officer.b');
    await profile.locator('#fullName').fill('Шинэчилсэн Нэр');
    await profile.getByRole('button', { name: 'Хадгалах' }).click();
    await expect.poll(() => api.callsTo('PUT', '/admin/users/:id').length).toBe(1);
    await expect(confirmDialog(page)).toHaveCount(0);

    // шинэ хэрэглэгч: ADMIN нэмбэл цонх гарч, POST баталгаажуулахаас өмнө явахгүй (зөвхөн OFFICER бол цонхгүй — admin-users.spec.ts)
    await page.getByRole('button', { name: 'Хэрэглэгч нэмэх' }).click();
    const create = createDialog(page);
    await create.locator('#username').fill('new.admin');
    await create.locator('#fullName').fill('Шинэ Админ');
    await create.locator('.ant-select').nth(1).click();
    await page.locator('.ant-select-item-option', { hasText: 'Төв салбар' }).click();
    await toggleRole(page, create, 'ADMIN');
    await create.getByRole('button', { name: 'Хадгалах' }).click();
    const confirm = confirmDialog(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Шинэ Админ');
    await expect(confirm).toContainText('new.admin');
    await expect(confirm).toContainText('Админ (ADMIN)');
    expect(api.callsTo('POST', '/admin/users')).toHaveLength(0);
    await confirm.getByRole('button', { name: 'Олгох' }).click();
    await expect.poll(() => api.callsTo('POST', '/admin/users').length).toBe(1);
    expect(api.lastCall('POST', '/admin/users')!.body).toMatchObject({ username: 'new.admin', roles: expect.arrayContaining(['ADMIN']) });
    expectClean(guard, api);
  });

  test('4. сервер ROLE_COMBINATION_FORBIDDEN / SELF_ROLE_GRANT гэж 422 хариулбал мессеж маягт дотор үлдэж, маягт нээлттэй хэвээр', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    const state = installApi(api);
    await page.goto('/settings/users');

    const dialog = await editUser(page, 'officer.b');
    await toggleRole(page, dialog, 'BRANCH_MANAGER'); // эрх өсгөх дүр биш → баталгаажуулах цонхгүй, шууд PUT
    const combo = 'Нэг хүнд OFFICER ба APPROVER дүрийг зэрэг олгох боломжгүй (бэлтгэгч ба батлагч тусдаа хүн байх ёстой)';
    state.putError = { code: 'ROLE_COMBINATION_FORBIDDEN', message: combo };
    await dialog.getByRole('button', { name: 'Хадгалах' }).click();
    await expect(dialog.getByRole('alert')).toContainText(combo);
    await expect(dialog).toBeVisible();

    const self = 'Өөртөө дүр нэмэх боломжгүй: өөр админаар олгуулна уу';
    state.putError = { code: 'SELF_ROLE_GRANT', message: self };
    await dialog.getByRole('button', { name: 'Хадгалах' }).click();
    await expect(dialog.getByRole('alert')).toContainText(self);
    await expect(dialog.getByRole('alert')).not.toContainText('зэрэг олгох боломжгүй');
    await expect(dialog).toBeVisible();
    expect(api.callsTo('PUT', '/admin/users/:id')).toHaveLength(2);

    // дахин нээхэд хуучин алдаа үлдэхгүй
    await dialog.getByRole('button', { name: 'Болих' }).click();
    await expect(dialog).toBeHidden();
    await editUser(page, 'officer.b');
    await expect(editDialog(page).getByRole('alert')).toHaveCount(0);
    expectClean(guard, api);
  });
});
