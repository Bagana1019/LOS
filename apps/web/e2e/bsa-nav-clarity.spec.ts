import { expect, test, type Page } from '@playwright/test';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';
import { ANALYSIS_URL, APP_ID, installBsa, newBsaWorld, OVERVIEW_URL, SC, type BsaWorld } from './bsa-mock';

// BSA: хүсэлт рүү буцах зам, ойлгомжтой нэр (F6-1) ба дохио шийдвэрлэсний үр дүн (F6-10). Gateway-г mock хийсэн.

async function setup(page: Page, o: Partial<BsaWorld> = {}) {
  const api = new MockApi('OFFICER');
  const world = newBsaWorld(o);
  installBsa(api, world);
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, world };
}

/** Scoring-ийн жинхэнэ `ResolveResult` хэлбэр (`bsa-mock` нь `{ updated }` буцаадаг). */
const realResolve = (api: MockApi, world: BsaWorld, result: (open: string[]) => { resolved: number; skipped: number }) =>
  api.post(`${SC}/suspicions/resolve`, ({ body }) => {
    const req = body as { ids: string[]; action: string };
    world.resolves.push(body);
    const open = world.suspicions.filter((s) => req.ids.includes(s.id) && s.status === 'PENDING').map((s) => s.id);
    world.suspicions = world.suspicions.map((s) => (open.includes(s.id) ? { ...s, status: 'RESOLVED', action: req.action as 'APPROVE' } : s));
    const pending = world.suspicions.filter((s) => s.status === 'PENDING').length;
    return { json: { ...result(open), pending, summary: null, repushRequired: false } };
  });

const goSuspicions = async (page: Page) => { await page.goto(ANALYSIS_URL); await page.getByRole('tab', { name: 'Сэжигтэй дохио' }).click(); };
const pickRow = (page: Page, flagName: string) => page.getByRole('row', { name: flagName }).first().getByRole('checkbox').check();
const toast = (page: Page) => page.locator('.ant-message-notice-content');

test.describe('F6-1: BSA хуудас — хүсэлт рүү буцах зам ба ойлгомжтой нэр', () => {
  test('the overview offers a link back to the application', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(OVERVIEW_URL);
    const back = page.getByRole('link', { name: 'Хүсэлт рүү буцах' });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute('href', `/los/loan-application/${APP_ID}`);
    expectClean(guard, api);
  });

  test('the overview is titled "Дансны хуулгын шинжилгээ" without the unexplained abbreviation', async ({ page }) => {
    await setup(page);
    await page.goto(OVERVIEW_URL);
    await expect(page.getByRole('heading', { name: 'Дансны хуулгын шинжилгээ', exact: true })).toBeVisible();
  });

  test('the analysis page keeps the full name next to the version and still links back to the overview', async ({ page }) => {
    await setup(page);
    await page.goto(ANALYSIS_URL);
    await expect(page.getByRole('heading', { name: 'Дансны хуулгын шинжилгээ · v1', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Буцах', exact: true })).toHaveAttribute('href', `/los/bsa/${APP_ID}`);
  });
});

test.describe('F6-10: дохио шийдвэрлэсний үр дүнг хэлнэ', () => {
  test('reclassifying an income+expense pair says the income leg changed and the expense leg did not', async ({ page }) => {
    const { api, guard, world } = await setup(page);
    realResolve(api, world, (open) => ({ resolved: open.length, skipped: 0 }));
    await goSuspicions(page);
    await pickRow(page, 'Дугуй гүйлгээ');
    await page.locator('.ant-select').filter({ has: page.locator('#bsa-reclassify-category') }).click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Зээл (авсан зээлийн олголт)' }).click();
    await page.getByRole('button', { name: 'Ангилал солих', exact: true }).click();
    await expect.poll(() => world.resolves).toHaveLength(1);
    const t = toast(page).filter({ hasText: '1 дохионы ангиллыг' });
    await expect(t).toBeVisible();
    await expect(t).toContainText('1 гүйлгээний ангилал солигдлоо');
    await expect(t).toContainText('1 зарлагын гүйлгээ чиглэл таарахгүй тул өөрчлөгдсөнгүй');
    expectClean(guard, api);
  });

  test('the toast reports what the server resolved, not what was selected, and names the skipped ones', async ({ page }) => {
    const { api, world } = await setup(page);
    realResolve(api, world, () => ({ resolved: 1, skipped: 1 }));
    await goSuspicions(page);
    await pickRow(page, 'Өөрийн дансны шилжүүлэг');
    await pickRow(page, 'Орж ирээд шууд гарсан мөнгө');
    await page.getByRole('button', { name: 'Зөвшөөрөх', exact: true }).click();
    const t = toast(page).filter({ hasText: '1 дохиог зөвшөөрлөө' });
    await expect(t).toBeVisible();
    await expect(t).toContainText('1 дохио аль хэдийн шийдвэрлэгдсэн эсвэл олдоогүй тул алгасагдлаа');
    await expect(t).not.toContainText('гүйлгээний ангилал');
  });
});
