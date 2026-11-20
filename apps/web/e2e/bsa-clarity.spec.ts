import { expect, test, type Page } from '@playwright/test';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';
import { ANALYSIS_URL, BANK_NOT_DETECTED_MESSAGE, FAILED_JOB, installBsa, newBsaWorld, OVERVIEW_URL, type BsaWorld } from './bsa-mock';

// BSA дэлгэцүүдийн тод байдал (naive-user тест F6-5, F6-9, F6-11, F6-13, F6-14). Gateway-г mock хийсэн.

async function setup(page: Page, o: Partial<BsaWorld> = {}) {
  const api = new MockApi('OFFICER');
  const world = newBsaWorld(o);
  installBsa(api, world);
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, world };
}

/** Antd Select: `id`-аар олж, нээгээд сонголтыг нэрээр нь сонгоно. */
async function pick(page: Page, id: string, option: string) {
  await page.locator('.ant-select').filter({ has: page.locator(`#${id}`) }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: option }).first().click();
}

const optionTexts = (page: Page) => page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').allTextContents();
const goSuspicions = async (page: Page) => { await page.goto(ANALYSIS_URL); await page.getByRole('tab', { name: 'Сэжигтэй дохио' }).click(); };
const rowOf = (page: Page, text: string | RegExp) => page.getByRole('row', { name: text }).first();
const pickRow = (page: Page, flagName: string) => rowOf(page, flagName).getByRole('checkbox').check();
const file = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic statement') });

test.describe('F6-5: банк танигдаагүй хуулгыг гараар банк сонгож засах', () => {
  test('a failed "bank not recognised" job offers a bank Select and retries with the chosen bankCode', async ({ page }) => {
    const { world } = await setup(page, { jobs: [{ ...FAILED_JOB }] });
    await page.goto(ANALYSIS_URL);
    await expect(page.getByText(BANK_NOT_DETECTED_MESSAGE)).toBeVisible();
    await pick(page, 'bsa-retry-bank-job-1', 'Хаан банк');
    await page.getByRole('button', { name: 'Дахин оруулах' }).click();
    await expect.poll(() => world.retries).toEqual([{ id: 'job-1', body: { bankCode: 'KHAN' } }]);
  });

  test('the upload form has a bank Select with the 7 supported banks, and the chosen bank is sent per file', async ({ page }) => {
    const { world } = await setup(page);
    await page.goto(ANALYSIS_URL);
    await page.locator('.ant-select').filter({ has: page.locator('#bsa-upload-bank') }).click();
    expect(await optionTexts(page)).toEqual(['Хаан банк', 'Голомт банк', 'Худалдаа хөгжлийн банк', 'Хас банк', 'Капитрон банк', 'Төрийн банк', 'М банк']);
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Голомт банк' }).click();
    await page.setInputFiles('input[type=file]', [file('a.pdf'), file('b.pdf')]);
    await expect.poll(() => world.uploads.length).toBe(1);
    expect(world.uploads[0]?.raw).toContain('name="banks"');
    expect(world.uploads[0]?.raw).toContain('["GOLOMT","GOLOMT"]');
  });

  test('without a chosen bank no banks field is sent (the server auto-detects)', async ({ page }) => {
    const { world } = await setup(page);
    await page.goto(ANALYSIS_URL);
    await page.setInputFiles('input[type=file]', [file('a.pdf')]);
    await expect.poll(() => world.uploads.length).toBe(1);
    expect(world.uploads[0]?.raw).not.toContain('name="banks"');
  });
});

test.describe('F6-9: ангилал солих — системийн код бичихгүй, Монгол нэрээр сонгоно', () => {
  test('category is a Select of Mongolian names filtered by the transaction direction; the code stays internal', async ({ page }) => {
    const { world } = await setup(page);
    await goSuspicions(page);
    await expect(page.getByPlaceholder('Шинэ ангилал (код)')).toHaveCount(0);
    await pickRow(page, 'Өөрийн дансны шилжүүлэг'); // зөвхөн ОРЛОГО гүйлгээтэй дохио
    await page.locator('.ant-select').filter({ has: page.locator('#bsa-reclassify-category') }).click();
    const options = await optionTexts(page);
    expect(options).toContain('Зээл (авсан зээлийн олголт)');
    expect(options).not.toContain('Зээлийн төлбөр'); // зарлагын ангилал
    expect(options).not.toContain('Хуучин идэвхгүй ангилал'); // идэвхгүй
    expect(options.join('|')).not.toContain('LOAN_PROCEEDS'); // код харагдахгүй
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Зээл (авсан зээлийн олголт)' }).click();
    await page.getByRole('button', { name: 'Ангилал солих', exact: true }).click();
    await expect.poll(() => world.resolves).toEqual([{ ids: ['s-income'], action: 'RECLASSIFY', categoryCode: 'LOAN_PROCEEDS' }]);
  });

  test('a mixed income+expense selection offers both directions, grouped; the reclassify button waits for a choice', async ({ page }) => {
    await setup(page);
    await goSuspicions(page);
    await pickRow(page, 'Дугуй гүйлгээ'); // ОРЛОГО + ЗАРЛАГА хос
    await expect(page.getByRole('button', { name: 'Ангилал солих', exact: true })).toBeDisabled();
    await page.locator('.ant-select').filter({ has: page.locator('#bsa-reclassify-category') }).click();
    const options = await optionTexts(page);
    expect(options).toContain('Зээл (авсан зээлийн олголт)');
    expect(options).toContain('Зээлийн төлбөр');
    await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-group', { hasText: 'Зарлагын ангилал' })).toBeVisible();
  });
});

test.describe('F6-11: сэжигтэй дохионы хүснэгт — шийдэхэд хэрэгтэй багана, тайлбар', () => {
  test('rows show direction and confidence %, the detail shows counterparty, description and category name — no "·" header', async ({ page }) => {
    const { api, guard } = await setup(page);
    await goSuspicions(page);
    await expect(page.getByRole('columnheader', { name: 'Чиглэл' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Итгэл %' })).toBeVisible();
    await expect(rowOf(page, /Дугуй гүйлгээ/)).toContainText('92%');
    await expect(rowOf(page, /Дугуй гүйлгээ/)).toContainText('Орлого + зарлага');
    await expect(rowOf(page, /Орж ирээд шууд гарсан мөнгө/)).toContainText('Тодорхойгүй'); // итгэл % байхгүй — тайлбартай
    await rowOf(page, /Дугуй гүйлгээ/).locator('.ant-table-row-expand-icon').click();
    for (const h of ['Харьцсан данс', 'Гүйлгээний утга', 'Ангилал']) await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '·', exact: true })).toHaveCount(0);
    await expect(page.getByText('****9910')).toBeVisible();
    await expect(page.getByText('Зээл олголт')).toBeVisible();
    await expect(page.getByText('Бусад орлого').first()).toBeVisible(); // OTHER_INCOME-ийн Монгол нэр
    await expect(page.getByText('OTHER_INCOME')).toHaveCount(0);
    await expect(page.getByText('Данс тодорхойгүй')).toBeVisible(); // хоосон дансны оронд тайлбар
    await expect(page.getByText('Утга бичээгүй')).toBeVisible();
    expectClean(guard, api);
  });

  test('approve / exclude / reclassify explain their consequence in a tooltip', async ({ page }) => {
    await setup(page);
    await goSuspicions(page);
    await pickRow(page, 'Өөрийн дансны шилжүүлэг');
    await page.getByRole('button', { name: 'Зөвшөөрөх', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('орлого/зарлагад тооцно');
    await page.getByRole('button', { name: 'Тооцооноос хасах', exact: true }).hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'тооцохгүй' })).toBeVisible();
  });
});

test.describe('F6-13: «Системрүү татах» — баталгаажуулалт, түгжигдэх үр дагавар', () => {
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'Шинжилгээг системрүү татах уу?' });
  const pushButton = (page: Page) => page.getByRole('button', { name: 'Системрүү татах', exact: true });

  test('clicking push opens a confirmation that states unresolved signals, the figures and the lock; cancel sends nothing', async ({ page }) => {
    const { api, guard, world } = await setup(page);
    await page.goto(OVERVIEW_URL);
    await pushButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('4 шийдвэрлэгдээгүй');
    await expect(dialog(page)).toContainText('450,000₮'); // санал болгосон сарын төлбөр
    await expect(dialog(page)).toContainText('17%'); // ӨОХ
    await expect(dialog(page)).toContainText('түгжигдэнэ');
    await expect(dialog(page)).toContainText('өөрчлөх, буцаах боломжгүй');
    await dialog(page).getByRole('button', { name: 'Болих' }).click();
    await expect(dialog(page)).toBeHidden();
    expect(world.pushes).toEqual([]);
    expectClean(guard, api);
  });

  test('an unregistered proposed payment is called out in the confirmation', async ({ page }) => {
    await setup(page, { proposedMonthlyPayment: null });
    await page.goto(OVERVIEW_URL);
    await pushButton(page).click();
    await expect(dialog(page)).toContainText('Санал болгосон сарын төлбөр бүртгэгдээгүй');
  });

  test('confirming pushes exactly once', async ({ page }) => {
    const { world } = await setup(page);
    await page.goto(OVERVIEW_URL);
    await pushButton(page).click();
    await dialog(page).getByRole('button', { name: 'Системрүү татаж, түгжих' }).click();
    await expect.poll(() => world.pushes).toEqual(['an-1']);
    await expect(dialog(page)).toBeHidden();
  });

  test('once pushed, the analysis page explains why upload / recalculate / resolve are disabled', async ({ page }) => {
    await setup(page, { status: 'ANALYZED' });
    await page.goto(ANALYSIS_URL);
    await expect(page.getByText('Энэ шинжилгээ системрүү татагдсан тул түгжигдсэн')).toBeVisible();
  });
});

test.describe('F6-14: хураангуй таб — анхааруулга, аргачлал, задаргаа', () => {
  test('lists the analysis warnings and offers collapsible methodology and breakdown sections', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(ANALYSIS_URL);
    await expect(page.getByText('2 сарын хуулга дутуу байна.')).toBeVisible();
    await expect(page.getByText(/«Бусад» ангилал зарлагын 50\.7%/)).toBeVisible();
    await expect(page.getByText('Цалингийн сарын дундаж')).toHaveCount(0); // аргачлал хаалттай
    await page.getByText('Аргачлал (тооцооны алхмууд)').click();
    await expect(page.getByText('Цалингийн сарын дундаж')).toBeVisible();
    await expect(page.getByText('Σ цалин / сар', { exact: true })).toBeVisible(); // exact: Playwright-ийн case-insensitive тулгалт Σ-д таарахгүй
    await page.getByText('Орлого, зарлагын задаргаа').click();
    await expect(page.getByText('Хөдөлмөрийн орлого (цалин)').first()).toBeVisible();
    await expect(page.getByText('93%')).toBeVisible();
    expectClean(guard, api);
  });

  test('a stale stored summary is called out', async ({ page }) => {
    await setup(page, { summaryStale: true });
    await page.goto(ANALYSIS_URL);
    await expect(page.getByText('Хураангуй хуучирсан')).toBeVisible();
  });

  test('abbreviations are explained and the report tab no longer claims the PDF exists only after pushing', async ({ page }) => {
    await setup(page);
    await page.goto(ANALYSIS_URL);
    await page.getByText('ӨОХ-ийн орлого').first().hover();
    await expect(page.getByRole('tooltip').first()).toContainText('Өр орлогын харьцаа');
    await page.getByRole('tab', { name: 'Тайлан' }).click();
    await expect(page.getByText('PDF тайлан зөвхөн «Системрүү татсан» шинжилгээнд байна.')).toHaveCount(0);
    await expect(page.getByText('Ноорог шинжилгээний тайланг татаж болно')).toBeVisible();
  });
});
