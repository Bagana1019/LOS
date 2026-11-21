import { expect, test, type Page } from '@playwright/test';
import type { AdminBranchDto } from '@los/contracts';
import { guardConsole, MockApi } from './mock-api';

// ══ G1 · F9-11, F9-12: /settings/branches ══════════════════════════════════════════════════════════════════════════════════
const HEAD = '00000000-0000-4000-8000-000000000a01';
const branch = (o: Partial<AdminBranchDto> & { id: string; code: string }): AdminBranchDto => ({ name: `Салбар ${o.code}`, isActive: true, activeUserCount: 1, ...o });
// antd Modal-ийн `destroyOnClose` deprecation анхааруулга (өөр PR-ийн сэдэв) энд шалгагдахгүй.
const branchProblems = (guard: { problems: string[] }) => guard.problems.filter((p) => !/destroyOnClose/.test(p));

async function setupBranches(page: Page): Promise<MockApi> {
  const api = new MockApi('ADMIN');
  api.get('/admin/branches', { json: [branch({ id: HEAD, code: '100', name: 'Төв салбар' }), branch({ id: 'b-2', code: '200', name: 'Баянзүрх', activeUserCount: 0 })] });
  api.get('/settings', { json: [] });
  api.get('/maker-checker/requests', { json: { items: [], total: 0, page: 1, pageSize: 20 } });
  api.post('/admin/branches', ({ body }) => ({ status: 201, json: branch({ id: 'b-new', code: (body as { code: string }).code, name: (body as { name: string }).name, activeUserCount: 0 }) }));
  api.put('/admin/branches/:id', ({ params, body }) => ({ json: branch({ id: params.id, code: '100', name: (body as { name: string }).name }) }));
  await api.install(page);
  return api;
}

const formItem = (page: Page, id: string) => page.locator('.ant-form-item', { has: page.locator(`#${id}`) });
const branchWrites = (api: MockApi) => api.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/admin/branches'));

test.describe('G1 · салбар: хоёр өөр "Салбарын код" (F9-11)', () => {
  test('гэрээний дугаарын код өөр нэртэй, тайлбартай; "Салбарын код" гэсэн нэр зөвхөн салбарыг таних кодод үлдэнэ', async ({ page }) => {
    const guard = guardConsole(page);
    await setupBranches(page);
    await page.goto('/settings/branches');
    await expect(page.getByRole('table', { name: 'Салбарын жагсаалт' })).toContainText('Төв салбар');

    // Хоёр дахь карт: өөрийн нэр + тайлбар (аль нь аль болохыг тодорхой заана)
    const card = page.locator('.ant-card', { has: page.getByText('Гэрээний дугаарын салбарын код', { exact: true }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('салбарыг таних код');
    await expect(card.getByRole('columnheader', { name: 'Гэрээний дугаарт орох код' })).toBeVisible();
    await expect(card.getByLabel('Гэрээний дугаарт орох код Төв салбар')).toBeVisible();

    // "Салбарын код" яг нэг л газар (жагсаалтын багана) — өмнө нь картын гарчиг, баганын нэр, талбарын шошго гурав давтагддаг байсан
    await expect(page.getByText('Салбарын код', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByRole('table', { name: 'Салбарын жагсаалт' }).getByRole('columnheader', { name: 'Салбарын код', exact: true })).toBeVisible();
    expect(branchProblems(guard)).toEqual([]);
  });

  test('шинэ салбарын формд "Салбарын код" нь таних код гэдэг, гэрээний кодоос тусдаа гэдэг тайлбарласан', async ({ page }) => {
    await setupBranches(page);
    await page.goto('/settings/branches');
    await page.getByRole('button', { name: 'Салбар нэмэх' }).click();
    const code = formItem(page, 'code');
    await expect(code.getByText('Салбарын код', { exact: true })).toBeVisible();
    await expect(code).toContainText('Салбарыг таних код');
    await expect(code).toContainText('Гэрээний дугаарт орох код тусдаа');
  });
});

test.describe('G1 · салбар нэмэх форм: талбар бүрт Монгол алдаа (F9-12)', () => {
  const CODE_REQUIRED = 'Салбарын кодоо оруулна уу (жишээ: UB01)';
  const CODE_FORMAT = 'Код: зөвхөн латин үсэг, тоо (жишээ: UB01), 1–12 тэмдэгт. Кирилл үсэг, зай, тэмдэгт болохгүй';
  const NAME_REQUIRED = 'Салбарын нэрээ оруулна уу';
  const NAME_SHORT = 'Салбарын нэр дор хаяж 2 тэмдэгттэй байх ёстой';

  async function openCreate(page: Page): Promise<MockApi> {
    const api = await setupBranches(page);
    await page.goto('/settings/branches');
    await page.getByRole('button', { name: 'Салбар нэмэх' }).click();
    await expect(page.locator('#code')).toBeVisible();
    return api;
  }
  const save = (page: Page) => page.getByRole('button', { name: 'Хадгалах' });

  test('хоосон хадгалахад хоёр талбар НЭГЭН ЗЭРЭГ өөр өөрийн алдаатай; "Required"/toast байхгүй, сервер рүү юу ч явахгүй', async ({ page }) => {
    const guard = guardConsole(page);
    const api = await openCreate(page);
    await save(page).click();

    await expect(formItem(page, 'code').getByText(CODE_REQUIRED)).toBeVisible();
    await expect(formItem(page, 'name').getByText(NAME_REQUIRED)).toBeVisible();
    await expect(formItem(page, 'code')).toHaveClass(/ant-form-item-has-error/);
    await expect(formItem(page, 'name')).toHaveClass(/ant-form-item-has-error/);
    await expect(page.getByText('Required', { exact: true })).toHaveCount(0);
    await expect(page.locator('.ant-message-notice')).toHaveCount(0); // алдаа toast-оор биш талбарт
    expect(branchWrites(api)).toEqual([]);
    expect(branchProblems(guard)).toEqual([]);
  });

  test('кирилл код "тест", "F 9 !" → латин үсэг гэж заана; нэр "   " → заавал; нэр "А" → дор хаяж 2', async ({ page }) => {
    const api = await openCreate(page);
    await page.locator('#code').fill('тест');
    await expect(formItem(page, 'code').getByText(CODE_FORMAT)).toBeVisible();
    await page.locator('#code').fill('F 9 !');
    await expect(formItem(page, 'code').getByText(CODE_FORMAT)).toBeVisible();
    await page.locator('#name').fill('   ');
    await expect(formItem(page, 'name').getByText(NAME_REQUIRED)).toBeVisible();
    await page.locator('#name').fill('А');
    await expect(formItem(page, 'name').getByText(NAME_SHORT)).toBeVisible();

    // Олон удаа дарахад хуучин toast давхарлан үлдэхгүй
    await save(page).click();
    await save(page).click();
    await expect(page.locator('.ant-message-notice')).toHaveCount(0);
    expect(branchWrites(api)).toEqual([]);
  });

  test('зөв утга оруулахад алдаа арилж, серверт серверийн хэлбэрээр (том үсэг, trim) явна', async ({ page }) => {
    const api = await openCreate(page);
    await page.locator('#code').fill('тест');
    await expect(formItem(page, 'code').getByText(CODE_FORMAT)).toBeVisible();
    await page.locator('#code').fill('ub01');
    await page.locator('#name').fill('  Төв 2  ');
    await expect(formItem(page, 'code').getByText(CODE_FORMAT)).toHaveCount(0);
    await save(page).click();
    await expect.poll(() => api.callsTo('POST', '/admin/branches').length).toBe(1);
    expect(api.callsTo('POST', '/admin/branches')[0]!.body).toEqual({ code: 'UB01', name: 'Төв 2' });
  });

  test('салбар засахад нэрийг хоослоход нэрийн талбарт алдаа гарна (код шалгагдахгүй — өөрчлөгдөхгүй)', async ({ page }) => {
    const api = await setupBranches(page);
    await page.goto('/settings/branches');
    await page.getByRole('table', { name: 'Салбарын жагсаалт' }).locator('tr', { hasText: 'Төв салбар' }).getByRole('button', { name: 'Засах' }).click();
    await expect(page.locator('#code')).toBeDisabled();
    await page.locator('#name').fill('');
    await save(page).click();
    await expect(formItem(page, 'name').getByText(NAME_REQUIRED)).toBeVisible();
    await expect(formItem(page, 'code').locator('.ant-form-item-explain-error')).toHaveCount(0);
    expect(branchWrites(api)).toEqual([]);
  });
});
