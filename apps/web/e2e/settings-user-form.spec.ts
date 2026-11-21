import { expect, test, type Page } from '@playwright/test';
import type { AdminUserDto } from '@los/contracts';
import { guardConsole, MockApi } from './mock-api';

// ══ G3 · F9-13: /settings/users — хэрэглэгчийн форм ═════════════════════════════════════════════════════════════════════════
const U_HEAD = '00000000-0000-4000-8000-000000000a01';
const uUser = (o: Partial<AdminUserDto> & { id: string; username: string }): AdminUserDto => ({
  fullName: `${o.username} Бат`, roles: ['OFFICER'], branchId: U_HEAD, isActive: true, lastLoginAt: null, email: null, phone: null, mustChangePassword: false, ...o,
});

async function setupUsers(page: Page): Promise<MockApi> {
  const api = new MockApi('ADMIN');
  api.get('/admin/users', { json: [uUser({ id: 'id-officer.a', username: 'officer.a', roles: ['ADMIN'], branchId: null }), uUser({ id: 'u-2', username: 'officer.b', fullName: 'Бат Болд' })] });
  api.get('/admin/branches', { json: [{ id: U_HEAD, code: '100', name: 'Төв салбар', isActive: true, activeUserCount: 1 }] });
  api.post('/admin/users', ({ body }) => {
    const b = body as { username: string; fullName: string; roles: string[]; branchId: string | null };
    return { status: 201, json: { user: uUser({ id: 'u-new', username: b.username, fullName: b.fullName, roles: b.roles, branchId: b.branchId, mustChangePassword: true }), temporaryPassword: 'Tmp9xKq2LmNp4Rvw' } };
  });
  api.put('/admin/users/:id', ({ params, body }) => ({ json: uUser({ id: params.id, username: 'officer.b', ...(body as object) }) }));
  await api.install(page);
  return api;
}

const uItem = (page: Page, id: string) => page.locator('.ant-form-item', { has: page.locator(`#${id}`) });
const uSave = (page: Page) => page.getByRole('button', { name: 'Хадгалах' });
const userWrites = (api: MockApi) => api.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/admin/users'));

async function openUserCreate(page: Page): Promise<MockApi> {
  const api = await setupUsers(page);
  await page.goto('/settings/users');
  await expect(page.getByRole('table', { name: 'Хэрэглэгч' })).toContainText('officer.b');
  await page.getByRole('button', { name: 'Хэрэглэгч нэмэх' }).click();
  await expect(page.locator('#username')).toBeVisible();
  return api;
}

async function pickBranch(page: Page, name: string) {
  await page.locator('#branchId').click();
  await page.locator('.ant-select-item-option', { hasText: name }).click();
}

test.describe('G3 · хэрэглэгчийн форм: и-мэйл/утас/заавал талбарууд (F9-13)', () => {
  const EMAIL_FORMAT = 'И-мэйл хаяг буруу байна (жишээ: bat@example.mn)';
  const PHONE_FORMAT = 'Утас 8 оронтой тоо байх ёстой (жишээ: 99112233). +976 угтварыг автоматаар хасна';

  test('"bat@" и-мэйл няцаагдана — талбарт Монгол алдаа, сервер рүү юу ч явахгүй', async ({ page }) => {
    const guard = guardConsole(page);
    const api = await openUserCreate(page);
    await page.locator('#username').fill('bat.bold');
    await page.locator('#fullName').fill('Бат Болд');
    await page.locator('#email').fill('bat@');
    await pickBranch(page, 'Төв салбар');
    await uSave(page).click();

    await expect(uItem(page, 'email').getByText(EMAIL_FORMAT)).toBeVisible();
    await expect(uItem(page, 'email')).toHaveClass(/ant-form-item-has-error/);
    expect(userWrites(api)).toEqual([]);
    expect(guard.problems).toEqual([]);
  });

  test('хоосон хадгалахад нэвтрэх нэр, бүтэн нэр хоёр НЭГЭН ЗЭРЭГ өөр өөрийн Монгол алдаатай; "Required"/toast байхгүй', async ({ page }) => {
    const api = await openUserCreate(page);
    await uSave(page).click();

    await expect(uItem(page, 'username').getByText('Нэвтрэх нэрээ оруулна уу')).toBeVisible();
    await expect(uItem(page, 'fullName').getByText('Бүтэн нэрээ оруулна уу')).toBeVisible();
    await expect(page.getByText('Required', { exact: true })).toHaveCount(0);
    await expect(page.locator('.ant-message-notice')).toHaveCount(0);
    expect(userWrites(api)).toEqual([]);
  });

  test('кирилл нэвтрэх нэр "бат", бүтэн нэр "Б" → талбар бүрт заана; дүрийг бүгдийг нь хасвал "дор хаяж нэг дүр"', async ({ page }) => {
    await openUserCreate(page);
    await page.locator('#username').fill('бат');
    await expect(uItem(page, 'username').getByText('зөвхөн латин үсэг, тоо', { exact: false })).toBeVisible();
    await page.locator('#fullName').fill('Б');
    await expect(uItem(page, 'fullName').getByText('Бүтэн нэр дор хаяж 2 тэмдэгттэй байх ёстой')).toBeVisible();
    await page.locator('.ant-modal .ant-select-selection-item-remove').first().click();
    await expect(page.getByText('Дор хаяж нэг дүр сонгоно уу')).toBeVisible();
  });

  test('утас: "+976 9911-2233" зөвшөөрөгдөж серверт 8 оронтой "99112233" болж явна; "1234" → 8 оронтой гэж заана', async ({ page }) => {
    const api = await openUserCreate(page);
    await page.locator('#phone').fill('1234');
    await expect(uItem(page, 'phone').getByText(PHONE_FORMAT)).toBeVisible();

    await page.locator('#username').fill('bat.bold');
    await page.locator('#fullName').fill('Бат Болд');
    await page.locator('#email').fill('bat@example.mn');
    await page.locator('#phone').fill('+976 9911-2233');
    await expect(uItem(page, 'phone').getByText(PHONE_FORMAT)).toHaveCount(0);
    await pickBranch(page, 'Төв салбар');
    await uSave(page).click();

    await expect.poll(() => api.callsTo('POST', '/admin/users').length).toBe(1);
    expect(api.callsTo('POST', '/admin/users')[0]!.body).toMatchObject({ username: 'bat.bold', fullName: 'Бат Болд', email: 'bat@example.mn', phone: '99112233', roles: ['OFFICER'] });
  });

  test('засахад нэвтрэх нэр (өөрчлөгдөхгүй) шалгагдахгүй; бүтэн нэрийг хоослоход зөвхөн тэр талбарт алдаа', async ({ page }) => {
    const api = await setupUsers(page);
    await page.goto('/settings/users');
    await page.getByRole('table', { name: 'Хэрэглэгч' }).locator('tr', { hasText: 'officer.b' }).getByRole('button', { name: 'Засах' }).click();
    await expect(page.locator('#username')).toBeDisabled();
    await page.locator('#fullName').fill('');
    await uSave(page).click();
    await expect(uItem(page, 'fullName').getByText('Бүтэн нэрээ оруулна уу')).toBeVisible();
    await expect(uItem(page, 'username').locator('.ant-form-item-explain-error')).toHaveCount(0);
    expect(userWrites(api)).toEqual([]);
  });
});
