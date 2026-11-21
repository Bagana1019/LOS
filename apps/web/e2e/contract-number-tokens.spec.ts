import { expect, test, type Page } from '@playwright/test';
import { CONTRACT_NUMBER_TOKENS } from '@los/contracts';
import { guardConsole, MockApi } from './mock-api';

// F9-21 · /settings/contract-number: танигдаагүй {...}, давхар {SEQ}, файлын нэр эвддэг тэмдэгтийг хадгалахаас өмнө талбарын доор Монгол мессежээр няцаана;
// дэмжигдэх хэсгүүд + нэг жишээг талбарын доор үргэлж харуулна.
const TEMPLATE = { id: 'tpl-1', pattern: '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY' };
const TOKENS_TITLE = 'Загварт ашиглаж болох хэсгүүд';

async function setup(page: Page, stored: typeof TEMPLATE = TEMPLATE): Promise<MockApi> {
  const api = new MockApi('ADMIN');
  api.get('/contract-number-template', { json: stored });
  api.put('/contract-number-template', ({ body }) => ({ json: { id: stored.id, ...(body as object) } }));
  await api.install(page);
  return api;
}

const patternInput = (page: Page) => page.getByLabel('Загвар', { exact: true });
const inlineError = (page: Page) => page.locator('.ant-alert-error');
const saveButton = (page: Page) => page.getByRole('button', { name: 'Хадгалах' });
const templateWrites = (api: MockApi) => api.callsTo('PUT', '/contract-number-template');

test.describe('F9-21 · гэрээний дугаарын загвар: хэсгийн шалгалт', () => {
  test('талбарын доор дэмжигдэх бүх хэсэг (тайлбартай) ба нэг жишээ харагдана, тайлбар нь {YYYY} байхгүйг хэлнэ', async ({ page }) => {
    const guard = guardConsole(page);
    const api = await setup(page);
    await page.goto('/settings/contract-number');
    await expect(patternInput(page)).toHaveValue(TEMPLATE.pattern);

    const list = page.getByRole('list', { name: TOKENS_TITLE });
    await expect(list).toBeVisible();
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(CONTRACT_NUMBER_TOKENS.length);
    for (const [i, { token, label }] of CONTRACT_NUMBER_TOKENS.entries()) {
      await expect(items.nth(i)).toContainText(token);
      await expect(items.nth(i)).toContainText(label);
    }
    // Нэг жишээ: загвар → бодит дугаар (салбар 100, өнөөдөр, 1-р дугаар)
    const example = page.getByTestId('contract-number-example');
    await expect(example).toContainText('Загварын жишээ');
    await expect(example).toContainText('{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}');
    await expect(example).toContainText(/B100\d{6}01/);
    // Зөвлөмж: он нь {YYMMDD}-д орно, {YYYY} гэж хэсэг байхгүй
    await expect(page.locator('.ant-alert-info')).toContainText('{YYYY}');
    await expect(page.locator('.ant-alert-info')).toContainText('{YYMMDD}');
    await expect(inlineError(page)).toHaveCount(0);
    expect(api.unhandled).toEqual([]);
    expect(guard.problems).toEqual([]);
  });

  const BAD: Array<{ pattern: string; fragment: string; title: string }> = [
    { pattern: '{PREFIX}-{YYYY}-{SEQ}', fragment: '{YYYY}', title: 'танигдаагүй {YYYY} (олдворын яг оролт)' },
    { pattern: '{FOO}{SEQ}', fragment: '{FOO}', title: 'танигдаагүй {FOO}' },
    { pattern: '{PREFIX}{SEQ}{SEQ}', fragment: 'нэг л удаа', title: 'давхар {SEQ}' },
    { pattern: '{PREFIX}/{SEQ}', fragment: 'файлын нэр', title: 'файлын нэр эвддэг "/"' },
    { pattern: '{PREFIX}-{SEQ:11}', fragment: '{SEQ:11}', title: '{SEQ:11} хэт өргөн' },
  ];
  for (const { pattern, fragment, title } of BAD) {
    test(`${title}: талбарын доор Монгол мессеж, "Хадгалах" идэвхгүй, сервер рүү хүсэлт явахгүй`, async ({ page }) => {
      const api = await setup(page);
      await page.goto('/settings/contract-number');
      await patternInput(page).fill(pattern);

      await expect(inlineError(page)).toBeVisible();
      await expect(inlineError(page)).toContainText(fragment);
      await expect(inlineError(page)).not.toContainText(/String must|Invalid/);
      await expect(saveButton(page)).toBeDisabled();
      await expect(page.getByTestId('contract-number-example')).toBeVisible(); // тайлбар алдааны үед ч харагдсаар
      expect(templateWrites(api)).toHaveLength(0);
    });
  }

  test('танигдаагүй хэсгийн мессеж дэмжигдэх бүх хэсгийг жагсаана (үндсэн "Өдөр бүр" хүрээтэй үед ч эхний мессеж нь хэсгийн алдаа)', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/contract-number');
    await patternInput(page).fill('{PREFIX}-{YYYY}-{SEQ}');
    const error = inlineError(page);
    for (const { token } of CONTRACT_NUMBER_TOKENS) await expect(error).toContainText(token);
    await expect(error).toContainText('танигдаагүй');
    await expect(error).not.toContainText('өдөр бүр шинээр эхлэх'); // хүрээний мессеж хэсгийн алдаанаас ДАРАА
  });

  test('хоосон загвар англи биш Монгол мессеж өгнө', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/contract-number');
    await patternInput(page).fill('');
    await expect(inlineError(page)).toContainText('Загвар хоосон байж болохгүй');
    await expect(inlineError(page)).not.toContainText('String must contain');
    await expect(saveButton(page)).toBeDisabled();
  });

  test('зөв загвар: алдаа байхгүй, бодит жишээ харагдана, хадгалахад зөв биед PUT явна', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/settings/contract-number');
    await patternInput(page).fill('{PREFIX}-{YYMMDD}-{SEQ:3}');

    await expect(inlineError(page)).toHaveCount(0);
    await expect(page.locator('.ant-typography code').filter({ hasText: /^B-\d{6}-001$/ })).toBeVisible();
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect(page.getByText('Загвар хадгалагдлаа')).toBeVisible();
    expect(templateWrites(api)).toHaveLength(1);
    expect(templateWrites(api)[0]!.body).toEqual({ pattern: '{PREFIX}-{YYMMDD}-{SEQ:3}', prefix: 'B', seqScope: 'DAY' });
  });

  test('шалгалтаас өмнө хадгалагдсан буруу загвар: хуудас унахгүй ачаалж, алдааг шууд харуулна, засмагц хадгалж болно', async ({ page }) => {
    const guard = guardConsole(page);
    const api = await setup(page, { id: 'tpl-1', pattern: '{PREFIX}-{YYYY}-{SEQ}', prefix: 'LN', seqScope: 'GLOBAL' });
    await page.goto('/settings/contract-number');
    await expect(patternInput(page)).toHaveValue('{PREFIX}-{YYYY}-{SEQ}');
    await expect(inlineError(page)).toContainText('{YYYY}');
    await expect(saveButton(page)).toBeDisabled();

    await patternInput(page).fill('{PREFIX}-{SEQ:4}');
    await expect(inlineError(page)).toHaveCount(0);
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect(page.getByText('Загвар хадгалагдлаа')).toBeVisible();
    expect(templateWrites(api)[0]!.body).toEqual({ pattern: '{PREFIX}-{SEQ:4}', prefix: 'LN', seqScope: 'GLOBAL' });
    expect(guard.problems).toEqual([]);
  });
});
