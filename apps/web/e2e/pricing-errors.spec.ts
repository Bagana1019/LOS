import { expect, test, type Page } from '@playwright/test';
import { PricingTierSet, type PricingTierInput } from '@los/contracts';
import { guardConsole, MockApi, type MockReply } from './mock-api';

// F9-7: /settings/pricing серверийн 422 INVALID_TIER_SET-ийн issue-үүдийг (code + шатлалын код) монгол өгүүлбэрээр, формын дэргэд харуулна;
// хоосон нэр/буруу код серверт очихгүй. F9-6 (шошго): эрсдэлийн бүс RED/YELLOW/GREEN → Улаан/Шар/Ногоон.
const AT = '2026-11-20T03:00:00.000Z';
const PATH = '/loan-terms/pricing/tiers';
const TIERS: PricingTierInput[] = [
  { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650, interestRate: 22, feeRate: 0.015, isDefault: false },
  { code: 'C', name: 'Дундаж', band: 'YELLOW', minScore: 0, interestRate: 28, feeRate: 0.02, isDefault: true },
];

const tierSet = (tiers: PricingTierInput[]) => PricingTierSet.parse({ scope: 'DEFAULT', productId: null, version: 1, tiers, updatedAt: AT, updatedBy: null });
const invalidTierSet = (details?: unknown): MockReply => ({ status: 422, json: { code: 'INVALID_TIER_SET', message: 'Шатлал буруу байна', ...(details === undefined ? {} : { details }) } });
const ok = (tiers: PricingTierInput[]): MockReply => ({ json: tierSet(tiers) });

/** `puts[i]` = i-р PUT-д өгөх хариу (дууссан бол сүүлийнх давтагдана). */
async function setup(page: Page, puts: Array<(body: { tiers: PricingTierInput[] }) => MockReply>) {
  const api = new MockApi('ADMIN');
  let n = 0;
  api.get('/products', { json: [] });
  api.get(PATH, { json: tierSet(TIERS) });
  api.put(PATH, ({ body }) => puts[Math.min(n++, puts.length - 1)]!(body as { tiers: PricingTierInput[] }));
  await api.install(page);
  const guard = guardConsole(page);
  await page.goto('/settings/pricing');
  await expect(page.getByTestId('tier-0-rate')).toBeVisible();
  return { api, guard };
}

// antd нь loading дууссаны дараа ч "loading" дүрсийг a11y мод дотор үлдээдэг (нэр нь "loading Хадгалах") тул `exact` биш, төгсгөлөөр тулгана.
const save = (page: Page) => page.getByRole('button', { name: /(^|\s)Хадгалах$/ });
const issues = (page: Page) => page.getByTestId('tier-issues');
const field = (page: Page, i: number, f: 'code' | 'name') => page.getByTestId(`tier-${i}-${f}`);
const fieldError = (page: Page, i: number, f: 'code' | 'name') => page.getByTestId(`tier-${i}-${f}-error`);
const puts = (api: MockApi) => api.callsTo('PUT', PATH);

const DUPLICATE_CODE = 'B код давхардсан байна — шатлал бүрийн код өөр байх ёстой';
const MONOTONIC = 'B ба C шатлал: дээд оноотой C шатлалын хүү B шатлалынхаас бага (эсвэл ижил) байх ёстой';

test.describe('F9-7: INVALID_TIER_SET-ийн issue бүр ойлгомжтой өгүүлбэр', () => {
  test('сервер [DUPLICATE_CODE B, INTEREST_RATE_NOT_MONOTONIC B,C] буцаавал шатлалын кодыг нэрлэсэн өгүүлбэр формын дэргэд гарна', async ({ page }) => {
    const { guard } = await setup(page, [() => invalidTierSet([{ code: 'DUPLICATE_CODE', tiers: ['B'] }, { code: 'INTEREST_RATE_NOT_MONOTONIC', tiers: ['B', 'C'] }])]);
    await save(page).click();
    await expect(issues(page)).toBeVisible();
    await expect(issues(page).getByRole('listitem')).toHaveText([DUPLICATE_CODE, MONOTONIC]);
    await expect(page.getByText('Шатлал буруу байна', { exact: true })).toHaveCount(0); // ерөнхий толгой мессеж ганцаараа үлдэхгүй
    expect(guard.problems).toEqual([]);
  });

  test('серверийн бүх 7 issue код өгүүлбэртэй (түлхүүр/код шууд харагдахгүй)', async ({ page }) => {
    await setup(page, [() => invalidTierSet([
      { code: 'EMPTY', tiers: [] }, { code: 'FIRST_TIER_NOT_ZERO', tiers: ['C'] }, { code: 'DUPLICATE_MIN_SCORE', tiers: ['B', 'C'] }, { code: 'DUPLICATE_CODE', tiers: ['B'] },
      { code: 'DEFAULT_TIER_COUNT', tiers: [] }, { code: 'INTEREST_RATE_NOT_MONOTONIC', tiers: ['B', 'C'] }, { code: 'FEE_RATE_NOT_MONOTONIC', tiers: ['B', 'C'] },
    ])]);
    await save(page).click();
    await expect(issues(page).getByRole('listitem')).toHaveText([
      'Хамгийн багадаа нэг шатлал байх ёстой',
      'C шатлал хамгийн доод оноотой боловч 0-ээс эхлээгүй байна — хамгийн доод шатлалын доод оноо 0 байх ёстой',
      'B ба C шатлалын доод оноо ижил байна — шатлал бүрийн доод оноо өөр байх ёстой',
      DUPLICATE_CODE,
      'Анхдагч шатлал сонгоогдоогүй байна — яг нэг шатлалыг "Анхдагч" гэж тэмдэглэнэ үү',
      MONOTONIC,
      'B ба C шатлал: дээд оноотой C шатлалын шимтгэл B шатлалынхаас бага (эсвэл ижил) байх ёстой',
    ]);
  });

  test('засаад дахин хадгалахад амжилттай бол issue жагсаалт арилна', async ({ page }) => {
    const { api } = await setup(page, [() => invalidTierSet([{ code: 'DUPLICATE_CODE', tiers: ['B'] }]), (body) => ok(body.tiers)]);
    await save(page).click();
    await expect(issues(page)).toBeVisible();
    await save(page).click();
    await expect(page.getByText('Хадгалагдлаа')).toBeVisible();
    await expect(issues(page)).toHaveCount(0);
    expect(puts(api)).toHaveLength(2);
  });

  test('details задрахгүй бол серверийн мессеж хэвээр toast-оор гарна (жагсаалтгүй)', async ({ page }) => {
    await setup(page, [() => invalidTierSet()]);
    await save(page).click();
    await expect(page.getByText('Шатлал буруу байна', { exact: true })).toBeVisible();
    await expect(issues(page)).toHaveCount(0);
  });

  test('F9-7 алхам: код нь өөр мөртэй ижил болгоход мөр алга болохгүй, React key давхардлын анхааруулга гарахгүй; сервер DUPLICATE_CODE-оор хариулна', async ({ page }) => {
    const { api, guard } = await setup(page, [() => invalidTierSet([{ code: 'DUPLICATE_CODE', tiers: ['B'] }])]);
    await field(page, 1, 'code').fill('B');
    await expect(field(page, 0, 'code')).toHaveValue('B');
    await expect(field(page, 1, 'code')).toHaveValue('B');
    await save(page).click();
    await expect.poll(() => puts(api).length).toBe(1);
    expect((puts(api)[0]!.body as { tiers: PricingTierInput[] }).tiers.map((t) => t.code)).toEqual(['B', 'B']);
    await expect(issues(page).getByRole('listitem')).toHaveText([DUPLICATE_CODE]);
    expect(guard.problems).toEqual([]);
  });

  test('кодыг үсэг үсгээр бичихэд (pressSequentially) талбар фокусаа алдахгүй', async ({ page }) => {
    await setup(page, [(b) => ok(b.tiers)]);
    await field(page, 1, 'code').click();
    await page.keyboard.press('End');
    await field(page, 1, 'code').pressSequentially('x1');
    await expect(field(page, 1, 'code')).toHaveValue('CX1');
  });
});

test.describe('F9-7: хоосон нэр / буруу код серверт очихгүй', () => {
  test('хоосон нэр → "Нэр оруулна уу" талбарын доор, PUT явахгүй', async ({ page }) => {
    const { api } = await setup(page, [(b) => ok(b.tiers)]);
    await field(page, 0, 'name').fill('');
    await expect(fieldError(page, 0, 'name')).toHaveText('Нэр оруулна уу');
    await save(page).click();
    expect(puts(api)).toHaveLength(0);
  });

  test('код "A B" (зай) → хэлбэрийн алдаа; хоосон код → "Код оруулна уу"; PUT явахгүй', async ({ page }) => {
    const { api } = await setup(page, [(b) => ok(b.tiers)]);
    await field(page, 0, 'code').fill('a b');
    await expect(fieldError(page, 0, 'code')).toHaveText('Код зөвхөн A–Z, 0–9, _ тэмдэгттэй, 1–16 урттай байх ёстой');
    await field(page, 1, 'code').fill('');
    await expect(fieldError(page, 1, 'code')).toHaveText('Код оруулна уу');
    await save(page).click();
    expect(puts(api)).toHaveLength(0);
  });
});

test.describe('F9-6: эрсдэлийн бүсийн шошго', () => {
  test('RED/YELLOW/GREEN англи код биш Улаан/Шар/Ногоон харагдана; сонголт API-д кодоор явна', async ({ page }) => {
    const { api } = await setup(page, [(b) => ok(b.tiers)]);
    await expect(page.getByTestId('tier-0-band')).toContainText('Ногоон');
    await expect(page.getByTestId('tier-1-band')).toContainText('Шар');
    await expect(page.getByText(/^(RED|YELLOW|GREEN)$/)).toHaveCount(0);
    await page.getByTestId('tier-0-band').click();
    await expect(page.locator('.ant-select-item-option-content', { hasText: /^Улаан$/ })).toBeVisible();
    await expect(page.locator('.ant-select-item-option-content', { hasText: /^Шар$/ })).toBeVisible();
    await page.locator('.ant-select-item-option-content', { hasText: /^Улаан$/ }).click();
    await save(page).click();
    await expect.poll(() => puts(api).length).toBe(1);
    expect((puts(api)[0]!.body as { tiers: PricingTierInput[] }).tiers[0]).toMatchObject({ code: 'B', band: 'RED' });
  });
});
