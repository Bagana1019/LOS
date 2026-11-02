import { expect, test, type Page } from '@playwright/test';
import { ScorePreviewRequest, ScoreOverview, SelectMethodRequest, type UserRole } from '@los/contracts';
import { expectClean, expectNoHorizontalScroll } from './helpers';
import { guardConsole, MockApi } from './mock-api';
import {
  APP_ID, COMPUTED_AT, MIXED_INPUTS, TERMS, VERDICT_INPUTS, VERDICT_TERMS, emptyOverview, fakeUnderwrite, makeCalculation, makeOverview, previewResponse, reason, soscoInsufficient, soscoScored,
  type FakeInputs,
} from '../src/features/score/testing/fixtures';

// Wizard-ийн 7-р алхам «Тооцоолол» (`/los/loan-application/:id/score`, FR-8.1…8.6). Gateway-г mock хийсэн; сервер талын тооцоог fixtures-ийн
// хуурамч сервер (fakeUnderwrite) хийнэ — UI-ийн өөрийн тооцоолол байхгүй гэдгийг энд шалгана: харуулсан бүх тоо серверийн хариу.
const URL = `/los/loan-application/${APP_ID}/score`;
const PREVIEW = '/applications/:id/score/preview';
const CALCULATE = '/applications/:id/score/calculate';
const SELECTION = '/applications/:id/score/selection';
const OVERVIEW = '/applications/:id/score';

/** Серверийн мөнгөн дүн → UI-ийн формат (мянгатын таслал, бутархай байвал 2 орон, ₮) */
const money = (n: number): string => `${new Intl.NumberFormat('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n)}₮`;

interface Server {
  overview: ScoreOverview;
  inputs: FakeInputs;
}

async function setup(page: Page, init: { overview?: ScoreOverview; inputs?: FakeInputs; role?: UserRole } = {}) {
  const api = new MockApi(init.role ?? 'OFFICER');
  const state: Server = { overview: init.overview ?? makeOverview(), inputs: init.inputs ?? MIXED_INPUTS };
  api.get(OVERVIEW, () => ({ json: state.overview }));
  api.post(PREVIEW, ({ body }) => {
    const req = ScorePreviewRequest.parse(body);
    const base = state.overview.terms ?? TERMS;
    return { json: previewResponse({ amount: req.amount ?? base.amount, termMonths: req.termMonths ?? base.termMonths, interestRate: req.interestRate ?? base.interestRate }, state.inputs) };
  });
  api.post(CALCULATE, () => {
    const terms = state.overview.terms ?? TERMS;
    state.overview = makeOverview({ ...state.overview, calculation: makeCalculation({ terms, inputs: state.inputs }), sosco: soscoScored() });
    return { json: state.overview };
  });
  api.on('PUT', SELECTION, ({ body }) => {
    const req = SelectMethodRequest.parse(body);
    const calc = state.overview.calculation;
    if (!calc || calc.isStale) return { status: 409, json: { code: 'CALCULATION_STALE', message: 'x' } };
    state.overview = ScoreOverview.parse({
      ...state.overview,
      calculation: { ...calc, selectedMethod: req.method, selection: 'MANUAL', selectedBy: 'u1', selectedAt: COMPUTED_AT, selectionReason: req.reason ?? null },
    });
    return { json: state.overview };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, state };
}

const heading = (page: Page) => page.getByRole('heading', { name: 'Тооцоолол', level: 4 });
const calculateButton = (page: Page) => page.getByRole('button', { name: 'Тооцоолох (хадгалах)' });
const rowCells = (page: Page, key: string) => page.locator(`tr[data-row="${key}"] td:not(.ant-table-cell-fix-left)`);
const methodRadio = (page: Page, letter: 'A' | 'B' | 'C') => page.getByRole('radio', { name: new RegExp(`^${letter} · .* аргыг сонгох$`) });
const banner = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text });
const amountInput = (page: Page) => page.locator('#score-amount');
const previewBodies = (api: MockApi) => api.callsTo('POST', PREVIEW).map((c) => c.body as { amount: number; termMonths: number; interestRate: number });

async function open(page: Page) {
  await page.goto(URL);
  await expect(heading(page)).toBeVisible();
}

test.describe('эхний ачаалал (хадгалсан тооцоололтой)', () => {
  test('гарчиг, төлөвийн шошго, A/B/C баганууд, автомат C, бодлогын шалгуур, шууд тоо, Sosco', async ({ page }) => {
    const { api, guard, state } = await setup(page);
    await open(page);

    await expect(page.getByTestId('score-status')).toContainText('Хадгалсан · 2026-10-29 14:05');
    await expect(page.getByTestId('score-status')).toContainText('Сонгосон: C · Хосолсон · Автомат');

    const headers = page.getByRole('columnheader');
    await expect(headers.filter({ hasText: 'A · Цалин' })).toHaveCount(1);
    await expect(headers.filter({ hasText: 'B · Бизнес' })).toHaveCount(1);
    const cHeader = headers.filter({ hasText: 'C · Хосолсон' });
    await expect(cHeader).toContainText('Автомат');
    await expect(cHeader).toContainText('Сонгосон');
    await expect(headers.filter({ hasText: 'A · Цалин' })).not.toContainText('Автомат');

    await expect(methodRadio(page, 'C')).toBeChecked();
    await expect(methodRadio(page, 'A')).toBeEnabled();
    await expect(methodRadio(page, 'B')).toBeEnabled();

    // Мөр бүр: серверийн утгаар
    const methods = state.overview.calculation!.result.methods;
    await expect(rowCells(page, 'baseIncome')).toHaveText(methods.map((m) => money(m.baseIncome)));
    await expect(rowCells(page, 'ratio').nth(0)).toContainText('ӨОХ 41.3%');
    await expect(rowCells(page, 'ratio').nth(0)).toContainText('хязгаар ≤ 55%');
    await expect(rowCells(page, 'ratio').nth(1)).toContainText('ӨТЧХ 3.23');
    await expect(rowCells(page, 'ratio').nth(1)).toContainText('хязгаар ≥ 1.25');
    await expect(rowCells(page, 'verdict')).toHaveText(['Хангана', 'Хангана', 'Хангана']);
    await expect(rowCells(page, 'maxLoanAmount')).toHaveText(methods.map((m) => money(m.maxLoanAmount)));
    await expect(page.getByTestId('score-auto-basis')).toContainText('цалин (42.9%), бизнес (57.1%) аль нь ч 70%-аас даваагүй тул C арга');

    // Бодлогын шалгуур (result.policy-ээс форматлагдсан)
    const policy = page.getByRole('list', { name: 'Бодлогын шалгуур' });
    await expect(policy.getByRole('listitem')).toHaveText(['ӨОХ ≤ 55% (BR-1)', 'ӨТЧХ ≥ 1.25 (BR-2)', 'LTV ≤ 70% (BR-3)', 'Автомат сонголтын жин > 70% (BR-4)']);

    // Шууд тоо: хадгалсан тооцооллоос — preview хүсэлт явуулаагүй
    const loan = state.overview.calculation!.result.loan;
    await expect(page.locator('[data-live="monthlyPayment"] dd')).toHaveText(money(loan.monthlyPayment));
    await expect(page.locator('[data-live="totalDebtService"] dd')).toHaveText(money(methods[0]!.totalDebtService));
    await expect(page.locator('[data-live="totalInterest"] dd')).toHaveText(money(loan.totalInterest));

    // Барьцаа, stress, Sosco
    await expect(page.getByRole('region', { name: 'Барьцааны шалгуур (LTV)' })).toContainText('50.0% (хязгаар ≤ 70%)');
    await expect(page.getByRole('region', { name: 'Stress test' })).toContainText('+5 п.п.');
    await expect(page.getByRole('region', { name: 'Stress test' })).toContainText('-20%');
    await expect(page.getByTestId('score-sosco-score')).toHaveText(/724/);
    await expect(page.locator('[data-grade="B"]')).toBeVisible();
    await expect(page.getByTestId('score-sosco-coverage')).toHaveText('85%');
    await expect(page.getByText('мэдэгдэхгүй', { exact: true })).toBeVisible();

    expect(api.callsTo('POST', PREVIEW)).toHaveLength(0);
    expect(api.callsTo('GET', OVERVIEW)).toHaveLength(1);
    expectClean(guard, api);
  });

  test('хуудас хэвтээ гүйлгэгдэхгүй, давхар/нууц фокусжих элемент байхгүй, хүснэгт мөрүүд нэртэй', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await expectNoHorizontalScroll(page);
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      const ids = new Map<string, number>();
      for (const el of Array.from(document.querySelectorAll('main [id]'))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
      for (const [id, n] of ids) if (n > 1) out.push(`duplicate id "${id}" x${n}`);
      const focusable = 'a[href], button, input, select, textarea, [role=slider]';
      for (const el of Array.from(document.querySelectorAll(`main [aria-hidden="true"] :is(${focusable})`))) {
        if (el.getAttribute('tabindex') !== '-1') out.push(`focusable inside aria-hidden: <${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 40)}">`);
      }
      for (const el of Array.from(document.querySelectorAll('main :is(input, [role=slider], button)'))) {
        const e = el as HTMLElement;
        const name = e.getAttribute('aria-label') || (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent) || e.closest('label')?.textContent || e.textContent;
        if (!name?.trim() && getComputedStyle(e).display !== 'none') out.push(`no accessible name: <${e.tagName.toLowerCase()} class="${(e.getAttribute('class') ?? '').slice(0, 40)}">`);
      }
      return out;
    });
    expect(problems).toEqual([]);
    // radio бүр нэртэй, нэг бүлэгт
    await expect(page.getByRole('radiogroup', { name: 'Шийдвэрт ашиглах арга' }).getByRole('radio')).toHaveCount(3);
    expectClean(guard, api);
  });
});

test.describe('гурван төлөв ба шалтгаан (FR-8.4, FR-8.6)', () => {
  test('A хангана (ногоон) · B хамаарахгүй (саарал) · C хангахгүй (улаан): дүрс + текст, шалтгаан бүр засах алхмын линктэй', async ({ page }) => {
    const { api, guard } = await setup(page, { overview: makeOverview({ calculation: makeCalculation({ terms: VERDICT_TERMS, inputs: VERDICT_INPUTS }) }), inputs: VERDICT_INPUTS });
    await open(page);

    const verdict = rowCells(page, 'verdict');
    await expect(verdict).toHaveText(['Хангана', 'Хамаарахгүй', 'Хангахгүй']);
    await expect(verdict.nth(0).locator('[data-tone="pass"]')).toBeVisible();
    await expect(verdict.nth(1).locator('[data-tone="na"]')).toBeVisible();
    await expect(verdict.nth(2).locator('[data-tone="fail"]')).toBeVisible();
    // Өнгөөр ганцаараа биш: дүрс (aria-hidden) + текст
    await expect(verdict.nth(0).locator('.anticon-check-circle')).toHaveCount(1);
    await expect(verdict.nth(1).locator('.anticon-minus-circle')).toHaveCount(1);
    await expect(verdict.nth(2).locator('.anticon-close-circle')).toHaveCount(1);
    // Харьцааны нүд: дүрс нэртэй (дэлгэц уншигч)
    await expect(rowCells(page, 'ratio').nth(0).getByRole('img', { name: 'Хангана' })).toBeVisible();
    await expect(rowCells(page, 'ratio').nth(1).getByRole('img', { name: 'Хамаарахгүй' })).toBeVisible();
    await expect(rowCells(page, 'ratio').nth(2).getByRole('img', { name: 'Хангахгүй' })).toBeVisible();

    const reasons = rowCells(page, 'reasons');
    await expect(reasons.nth(0)).toHaveText('—');
    await expect(reasons.nth(1)).toContainText('Бизнесийн орлого (ЦМУ) байхгүй');
    await expect(reasons.nth(2)).toContainText('Өрийн төлбөр чадварын харьцаа (ӨТЧХ) доод хязгаараас бага байна');
    await expect(reasons.nth(1).getByRole('link', { name: 'Засах: Орлого' })).toHaveAttribute('href', `/los/loan-application/${APP_ID}/income`);
    await expect(reasons.nth(2).getByRole('link', { name: 'Засах: Зээлийн мэдээлэл' })).toHaveAttribute('href', `/los/loan-application/${APP_ID}/loan`);

    // Хамаарахгүй арга сонгогдохгүй
    await expect(methodRadio(page, 'B')).toBeDisabled();
    await expect(methodRadio(page, 'A')).toBeEnabled();
    await expect(methodRadio(page, 'C')).toBeEnabled();

    // Шалтгааны линк рүү шилжинэ
    await reasons.nth(1).getByRole('link', { name: 'Засах: Орлого' }).click();
    await page.waitForURL(`**/los/loan-application/${APP_ID}/income`);
    expectClean(guard, api);
  });

  test('LTV хэтэрсэн: барьцааны карт улаан, шалтгаан /collateral линктэй; арга бүрт «Барьцааны LTV хангаагүй»', async ({ page }) => {
    const inputs = { ...MIXED_INPUTS, collateralValue: 20_000_000 };
    const { api, guard } = await setup(page, { overview: makeOverview({ calculation: makeCalculation({ inputs }) }), inputs });
    await open(page);
    const card = page.getByRole('region', { name: 'Барьцааны шалгуур (LTV)' });
    await expect(card.locator('[data-tone="fail"]').first()).toBeVisible();
    await expect(card.getByRole('link', { name: 'Засах: Барьцаа' })).toHaveAttribute('href', `/los/loan-application/${APP_ID}/collateral`);
    await expect(rowCells(page, 'verdict').nth(0)).toContainText('Хангахгүй');
    await expect(rowCells(page, 'verdict').nth(0)).toContainText('Барьцааны LTV хангаагүй');
    await expect(rowCells(page, 'ratio').nth(0).getByRole('img', { name: 'Хангана' })).toBeVisible(); // харьцаа хангасан, барьцаа саад
    expectClean(guard, api);
  });
});

test.describe('slider → preview (FR-8.3)', () => {
  test('дүн оруулахад ~350 мс-ийн дараа ганц preview хүсэлт; шууд тоо серверийн хариугаар шинэчлэгдэнэ; хадгалагдаагүй гэж тэмдэглэнэ', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await amountInput(page).fill('30000000');
    await expect(banner(page, 'Урьдчилсан харагдац: хадгалагдаагүй')).toBeVisible();
    await expect(banner(page, 'Slider-ийн нөхцөлөөр харуулж байна: 30,000,000₮, 24 сар, 23.99%')).toBeVisible();

    const expected = fakeUnderwrite({ ...TERMS, amount: 30_000_000 });
    await expect(page.locator('[data-live="monthlyPayment"] dd')).toHaveText(money(expected.loan.monthlyPayment));
    await expect(page.locator('[data-live="totalInterest"] dd')).toHaveText(money(expected.loan.totalInterest));
    await expect(page.locator('[data-live="totalDebtService"] dd')).toHaveText(money(expected.methods[2]!.totalDebtService));
    // Харьцуулах хүснэгт ч урьдчилсан үр дүнгээр
    await expect(rowCells(page, 'maxLoanAmount').nth(0)).toHaveText(money(expected.methods[0]!.maxLoanAmount));
    await expect(rowCells(page, 'ratio').nth(0)).toContainText('ӨОХ 5');
    expect(previewBodies(api)).toEqual([{ amount: 30_000_000, termMonths: 24, interestRate: 23.99 }]);

    // Сонголт хаалттай, Sosco хадгалсан тооцооллынх
    for (const l of ['A', 'B', 'C'] as const) await expect(methodRadio(page, l)).toBeDisabled();
    await expect(page.getByText('Арга сонгохын тулд slider-ийг хадгалсан нөхцөл рүү буцаана уу.')).toBeVisible();
    await expect(page.getByText('Sosco нь хадгалсан тооцооллынх: slider-ээр өөрчлөгдөхгүй.')).toBeVisible();
    await expect(page.getByTestId('score-sosco-score')).toHaveText(/724/);
    expectClean(guard, api);
  });

  test('товчлуурын навигаци: slider-ийг 5 удаа хурдан шахахад нэг л хүсэлт (debounce), хамгийн сүүлийн утгаар', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    const handle = page.getByRole('slider', { name: 'Зээлийн дүн' });
    await expect(handle).toHaveAttribute('aria-valuenow', '20000000');
    await expect(handle).toHaveAttribute('aria-valuetext', '20,000,000₮');
    await handle.focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight'); // алхам 100,000 ₮
    await expect(handle).toHaveAttribute('aria-valuenow', '20500000');
    await expect(amountInput(page)).toHaveValue('20,500,000');
    await expect.poll(() => previewBodies(api).length).toBeGreaterThan(0);
    await page.waitForTimeout(700); // дахин хүсэлт ирэхгүйг баталгаажуулна
    expect(previewBodies(api)).toEqual([{ amount: 20_500_000, termMonths: 24, interestRate: 23.99 }]);
    await expect(page.locator('[data-live="monthlyPayment"] dd')).toHaveText(money(fakeUnderwrite({ ...TERMS, amount: 20_500_000 }).loan.monthlyPayment));

    // Хугацаа, хүү ч мөн адил
    const term = page.getByRole('slider', { name: 'Хугацаа (сар)' });
    await term.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#score-term')).toHaveValue('26');
    await expect.poll(() => previewBodies(api).at(-1)).toEqual({ amount: 20_500_000, termMonths: 26, interestRate: 23.99 });
    const rate = page.getByRole('slider', { name: 'Жилийн хүү (%)' });
    await rate.focus();
    await page.keyboard.press('ArrowLeft');
    // slider-ийн алхам 0.1: 23.99 → хамгийн ойрын 23.9 (rc-slider алхмын торонд тохируулна)
    await expect.poll(() => previewBodies(api).at(-1)?.interestRate ?? 0).toBeLessThan(23.95); // debounce-ийн дараа
    expect(previewBodies(api).at(-1)!.interestRate).toBeGreaterThan(23.8);
    expectClean(guard, api);
  });

  test('хоцорсон хариу шинэ утгыг дарахгүй (latest wins)', async ({ page }) => {
    const { api, guard } = await setup(page);
    // Эхний хүсэлт (25 сая) удаан, хоёр дахь (30 сая) шууд. Хөтөч эхнийг цуцалсан тул хоцорсон fulfill амжилтгүй болно — алдааг барина.
    await page.route('**/api/origination/applications/*/score/preview', async (route) => {
      const req = ScorePreviewRequest.parse(route.request().postDataJSON());
      const slow = req.amount === 25_000_000;
      if (slow) await new Promise((r) => setTimeout(r, 1200));
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(previewResponse({ amount: req.amount!, termMonths: req.termMonths!, interestRate: req.interestRate! })) });
      } catch {
        /* цуцлагдсан хүсэлт */
      }
    });
    await open(page);
    await amountInput(page).fill('25000000');
    await page.waitForTimeout(450); // debounce өнгөрч, эхний хүсэлт нисэж байна
    await amountInput(page).fill('30000000');
    const expected = fakeUnderwrite({ ...TERMS, amount: 30_000_000 });
    await expect(page.locator('[data-live="monthlyPayment"] dd')).toHaveText(money(expected.loan.monthlyPayment));
    await page.waitForTimeout(1500); // удаан хариу хэзээ ч ирсэн байсан үр дүн өөрчлөгдөхгүй
    await expect(page.locator('[data-live="monthlyPayment"] dd')).toHaveText(money(expected.loan.monthlyPayment));
    await expect(banner(page, 'Slider-ийн нөхцөлөөр харуулж байна: 30,000,000₮, 24 сар, 23.99%')).toBeVisible();
    expect(api.unhandled).toEqual([]);
    expect(guard.problems).toEqual([]);
  });

  test('«Хадгалсан нөхцөл рүү буцах» — slider сэргэж, хадгалсан тооцоо буцаж харагдана', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await page.locator('#score-term').fill('48');
    await expect(banner(page, 'Урьдчилсан харагдац: хадгалагдаагүй')).toBeVisible();
    await expect(page.getByTestId('score-dirty')).toContainText('Хадгалсан нөхцөл: 20,000,000₮, 24 сар, 23.99%');
    await page.getByRole('button', { name: 'Хадгалсан нөхцөл рүү буцах' }).click();
    await expect(page.locator('#score-term')).toHaveValue('24');
    await expect(banner(page, 'Урьдчилсан харагдац')).toHaveCount(0);
    await expect(page.getByTestId('score-dirty')).toHaveCount(0);
    await expect(methodRadio(page, 'C')).toBeChecked();
    await expect(methodRadio(page, 'C')).toBeEnabled();
    await expect(page.getByTestId('score-status')).toContainText('Хадгалсан · 2026-10-29 14:05');
    expectClean(guard, api);
  });

  test('хязгаараас гарсан утга: оролт улаан, preview явуулахгүй; хязгаарт буцахад үргэлжилнэ', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await amountInput(page).fill('100000'); // доод хязгаар 500,000 ₮
    await expect(page.locator('#score-amount-hint')).toHaveText('Бүтээгдэхүүний хязгаараас гарсан: 500,000₮ – 50,000,000₮');
    await expect(amountInput(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Хязгаараас гарсан утгад урьдчилсан тооцоо хийхгүй.')).toBeVisible();
    await page.waitForTimeout(600);
    expect(previewBodies(api)).toHaveLength(0);
    await amountInput(page).fill('5000000');
    await expect.poll(() => previewBodies(api)).toEqual([{ amount: 5_000_000, termMonths: 24, interestRate: 23.99 }]);
    await expect(page.locator('#score-amount-hint')).toHaveText('Хязгаар: 500,000₮ – 50,000,000₮');
    expectClean(guard, api);
  });

  test('preview алдаа: хадгалсан тооцоог харуулсаар, slider-ийн хажууд алдаа + «Дахин оролдох»', async ({ page }) => {
    const { api, guard } = await setup(page);
    let fail = true;
    api.post(PREVIEW, ({ body }) => {
      if (fail) return { status: 503, json: { code: 'SCORING_UNAVAILABLE', message: 'x' } };
      const req = ScorePreviewRequest.parse(body);
      return { json: previewResponse({ amount: req.amount!, termMonths: req.termMonths!, interestRate: req.interestRate! }) };
    });
    await open(page);
    await amountInput(page).fill('15000000');
    const error = page.getByRole('alert').filter({ hasText: 'Урьдчилсан тооцоо хийж чадсангүй' });
    await expect(error).toBeVisible();
    await expect(error).toContainText('Тооцооллын үйлчилгээ түр ажиллахгүй байна. Дахин оролдоно уу.');
    await expect(banner(page, 'Урьдчилсан тооцоо хийгдэх хүртэл хадгалсан тооцоог харуулж байна.')).toBeVisible();
    fail = false;
    await error.getByRole('button', { name: 'Дахин оролдох' }).click();
    await expect(error).toHaveCount(0);
    await expect(banner(page, 'Slider-ийн нөхцөлөөр харуулж байна: 15,000,000₮, 24 сар, 23.99%')).toBeVisible();
    expectClean(guard, api);
  });
});

test.describe('тооцоолох (хадгалах) — FR-8.1', () => {
  test('тооцоолол хараахан байхгүй: одоогийн нөхцөлийн урьдчилсан харагдац; «Тооцоолох» дарахад хадгалагдаж, сонголт идэвхжинэ', async ({ page }) => {
    const { api, guard } = await setup(page, { overview: emptyOverview() });
    await open(page);
    await expect(banner(page, 'Тооцоолол хараахан хадгалагдаагүй')).toContainText('Одоогийн нөхцөлөөр урьдчилан харуулж байна: 20,000,000₮, 24 сар, 23.99%');
    await expect(page.getByTestId('score-status')).toContainText('Урьдчилсан харагдац');
    await expect(rowCells(page, 'verdict')).toHaveText(['Хангана', 'Хангана', 'Хангана']);
    await expect.poll(() => previewBodies(api)).toEqual([{ amount: 20_000_000, termMonths: 24, interestRate: 23.99 }]);
    for (const l of ['A', 'B', 'C'] as const) await expect(methodRadio(page, l)).toBeDisabled();
    await expect(page.getByText('Sosco Score хараахан тооцоологдоогүй.')).toBeVisible();
    await expect(page.getByText('Арга сонгох боломжгүй: тооцоолол хадгалагдаагүй байна.')).toBeVisible();

    await calculateButton(page).click();
    await expect(page.getByText('Тооцоолол хадгалагдлаа').first()).toBeVisible();
    await expect(page.getByTestId('score-status')).toContainText('Хадгалсан · 2026-10-29 14:05');
    await expect(page.getByTestId('score-status')).toContainText('Сонгосон: C · Хосолсон · Автомат');
    await expect(banner(page, 'Тооцоолол хараахан хадгалагдаагүй')).toHaveCount(0);
    await expect(methodRadio(page, 'C')).toBeChecked();
    await expect(methodRadio(page, 'A')).toBeEnabled();
    await expect(page.getByTestId('score-sosco-score')).toHaveText(/724/);
    await expect(page.getByTestId('score-announcer')).toHaveText('Тооцоолол хадгалагдлаа.');
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(1);
    expect(api.callsTo('POST', CALCULATE)[0]!.body).toBeFalsy(); // хадгалсан нөхцөлөөр: body байхгүй
    expectClean(guard, api);
  });

  test('давхар дарахад нэг л хүсэлт (товч loading үед идэвхгүй)', async ({ page }) => {
    const { api, guard } = await setup(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); // хариуг гараар барина: хугацаанаас хамаарахгүй тогтвортой
    api.post(CALCULATE, async () => {
      await gate;
      return { json: makeOverview({ calculation: makeCalculation({ selectedMethod: 'A_SALARY', selection: 'MANUAL' }) }) };
    });
    await open(page);
    const button = calculateButton(page);
    await button.click();
    await expect(button).toHaveClass(/ant-btn-loading/);
    await button.click({ force: true }); // loading үед antd товчийн дарлтыг үл тооно
    await page.waitForTimeout(300);
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(1);
    release();
    await expect(page.getByTestId('score-status')).toContainText('Сонгосон: A · Цалин · Гараар');
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(1);
    expectClean(guard, api);
  });

  test('slider өөрчлөгдсөн үед хадгалахад хадгалсан нөхцөлөөр тооцоолж, slider сэргэнэ (хадгалагдсан үр дүн харагдана)', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await page.locator('#score-term').fill('36');
    await expect(page.getByText('Slider-ийн утга хадгалагдахгүй: хадгалсан нөхцөлөөр тооцоолно.')).toBeVisible();
    await calculateButton(page).click();
    await expect(page.locator('#score-term')).toHaveValue('24');
    await expect(banner(page, 'Урьдчилсан харагдац')).toHaveCount(0);
    await expect(methodRadio(page, 'C')).toBeEnabled();
    expectClean(guard, api);
  });

  test('SCORING_UNAVAILABLE: алдаа + «Дахин оролдох» → амжилттай', async ({ page }) => {
    const { api, guard, state } = await setup(page, { overview: emptyOverview() });
    let fail = true;
    api.post(CALCULATE, () => {
      if (fail) return { status: 503, json: { code: 'SCORING_UNAVAILABLE', message: 'x' } };
      state.overview = makeOverview();
      return { json: state.overview };
    });
    await open(page);
    await calculateButton(page).click();
    const error = page.getByRole('alert').filter({ hasText: 'Тооцоолж чадсангүй' });
    await expect(error).toContainText('Тооцооллын үйлчилгээ түр ажиллахгүй байна. Дахин оролдоно уу.');
    fail = false;
    await error.getByRole('button', { name: 'Дахин оролдох' }).click();
    await expect(error).toHaveCount(0);
    await expect(page.getByTestId('score-status')).toContainText('Хадгалсан · 2026-10-29 14:05');
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(2);
    expectClean(guard, api);
  });

  test('overview ачаалах үед SCORING_UNAVAILABLE: алдаа + дахин оролдох; skeleton хүлээлтэнд', async ({ page }) => {
    const { api, guard } = await setup(page);
    let fail = true;
    api.get(OVERVIEW, () => (fail ? { status: 503, json: { code: 'SCORING_UNAVAILABLE', message: 'x' } } : { delayMs: 300, json: makeOverview() }));
    await page.goto(URL);
    const error = page.getByRole('alert').filter({ hasText: 'Тооцооллыг ачаалж чадсангүй' });
    await expect(error).toBeVisible({ timeout: 20_000 }); // 5xx нэг удаа дахин оролддог
    await expect(error).toContainText('Тооцооллын үйлчилгээ түр ажиллахгүй байна');
    fail = false;
    await error.getByRole('button', { name: 'Дахин оролдох' }).click();
    await expect(page.getByRole('status', { name: 'Тооцооллыг ачаалж байна' })).toBeVisible();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByRole('status', { name: 'Тооцооллыг ачаалж байна' })).toHaveCount(0);
    expectClean(guard, api);
  });
});

test.describe('арга сонгох (FR-8.2)', () => {
  test('B-г сонгох: тайлбартай modal → PUT {method, reason} → «Сонгосон (Гараар)»', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await methodRadio(page, 'B').click();
    const dialog = page.getByRole('dialog', { name: 'B · Бизнес аргыг сонгох' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Тайлбар (заавал биш)').fill('  Бизнесийн орлого тогтвортой  ');
    await dialog.getByRole('button', { name: 'Сонгох' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.callsTo('PUT', SELECTION).map((c) => c.body)).toEqual([{ method: 'B_BUSINESS', reason: 'Бизнесийн орлого тогтвортой' }]);
    await expect(page.getByTestId('score-status')).toContainText('Сонгосон: B · Бизнес · Гараар');
    await expect(methodRadio(page, 'B')).toBeChecked();
    const headers = page.getByRole('columnheader');
    await expect(headers.filter({ hasText: 'B · Бизнес' })).toContainText('Сонгосон (Гараар)');
    await expect(headers.filter({ hasText: 'C · Хосолсон' })).toContainText('Автомат');
    await expect(headers.filter({ hasText: 'C · Хосолсон' })).not.toContainText('Сонгосон');
    await expect(page.getByTestId('score-announcer')).toHaveText('B · Бизнес арга сонгогдлоо.');
    expectClean(guard, api);
  });

  test('тайлбар заавал биш: хоосон бол явуулахгүй; «Болих» хүсэлт явуулахгүй; Escape хаана', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await methodRadio(page, 'A').click();
    let dialog = page.getByRole('dialog', { name: 'A · Цалин аргыг сонгох' });
    await dialog.getByRole('button', { name: 'Болих' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(methodRadio(page, 'C')).toBeChecked();
    expect(api.callsTo('PUT', SELECTION)).toHaveLength(0);

    await methodRadio(page, 'A').click();
    dialog = page.getByRole('dialog', { name: 'A · Цалин аргыг сонгох' });
    await expect(dialog).toBeVisible();
    // Фокус modal дотор орсны дараа Escape хаана (a11y: фокус хүлжих)
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.ant-modal-wrap') !== null)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await methodRadio(page, 'A').click();
    dialog = page.getByRole('dialog', { name: 'A · Цалин аргыг сонгох' });
    await dialog.getByRole('button', { name: 'Сонгох' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.callsTo('PUT', SELECTION).map((c) => c.body)).toEqual([{ method: 'A_SALARY' }]);
    expectClean(guard, api);
  });

  test('товчлуураар: radio дээр Space → modal нээгдэнэ', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await methodRadio(page, 'A').focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'A · Цалин аргыг сонгох' })).toBeVisible();
    await page.keyboard.press('Escape');
    expectClean(guard, api);
  });

  test('сонголт амжилтгүй (409 CALCULATION_STALE): modal дотор мессеж, overview дахин татагдана', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.on('PUT', SELECTION, () => ({ status: 409, json: { code: 'CALCULATION_STALE', message: 'x' } }));
    await open(page);
    await methodRadio(page, 'A').click();
    const dialog = page.getByRole('dialog', { name: 'A · Цалин аргыг сонгох' });
    await dialog.getByRole('button', { name: 'Сонгох' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Тооцоолол хуучирсан тул арга сонгох боломжгүй. Дахин тооцоолно уу.');
    await expect.poll(() => api.callsTo('GET', OVERVIEW).length).toBeGreaterThan(1); // серверийн төлөвтэй тулгана
    await dialog.getByRole('button', { name: 'Болих' }).click();
    await expect(dialog).toHaveCount(0);
    expectClean(guard, api);
  });

  test('сонгогдсон аргыг дахин сонгоход юу ч болохгүй', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    await methodRadio(page, 'C').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.callsTo('PUT', SELECTION)).toHaveLength(0);
    expectClean(guard, api);
  });
});

test.describe('хуучирсан тооцоолол ба саад', () => {
  test('хуучирсан: анхааруулга + шалтгаан; сонголт хаалттай; «Дахин тооцоолох» → шинэчлэгдэнэ', async ({ page }) => {
    const stale = makeOverview({ calculation: makeCalculation({ isStale: true, staleReason: 'Зээлийн хүү өөрчлөгдсөн' }) });
    const { api, guard } = await setup(page, { overview: stale });
    await open(page);
    const alert = banner(page, 'Тооцоолол хуучирсан');
    await expect(alert).toContainText('Шалтгаан: Зээлийн хүү өөрчлөгдсөн');
    await expect(page.getByTestId('score-status')).toContainText('Хуучирсан');
    for (const l of ['A', 'B', 'C'] as const) await expect(methodRadio(page, l)).toBeDisabled();
    await expect(page.getByText('Арга сонгох боломжгүй: тооцоолол хуучирсан. Дахин тооцоолно уу.')).toBeVisible();
    await alert.getByRole('button', { name: 'Дахин тооцоолох' }).click();
    await expect(alert).toHaveCount(0);
    await expect(methodRadio(page, 'A')).toBeEnabled();
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(1);
    expectClean(guard, api);
  });

  test('хуучирсан тооцоолол дээр сонголт хийх оролдлого (сервер 409)-д тооцоолох заавар гарна', async ({ page }) => {
    const stale = makeOverview({ calculation: makeCalculation({ isStale: true }) });
    const { api, guard } = await setup(page, { overview: stale });
    await open(page);
    await expect(banner(page, 'Тооцоолол хуучирсан')).toContainText('Хүсэлтийн нөхцөл өөрчлөгдсөн тул дахин тооцоолно уу.');
    await expect(methodRadio(page, 'B')).toBeDisabled();
    expectClean(guard, api);
  });

  test('саад (зээлийн нөхцөл дутуу): анхааруулга + засах линк; «Тооцоолох» идэвхгүй; preview/calculate явахгүй', async ({ page }) => {
    const overview = emptyOverview({ terms: null, limits: null, blockers: [reason('LOAN_TERMS_MISSING')] });
    const { api, guard } = await setup(page, { overview });
    await open(page);
    const alert = banner(page, 'Тооцоолол хийх боломжгүй');
    await expect(alert).toContainText('Зээлийн нөхцөл (дүн, хугацаа, хүү) бөглөгдөөгүй байна');
    await expect(calculateButton(page)).toBeDisabled();
    await expect(page.getByText('Эхлээд тооцоолоход саад болж буй зүйлсийг засна уу.')).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.getByText('Харуулах тооцоолол алга.')).toBeVisible();
    await page.waitForTimeout(500);
    expect(api.callsTo('POST', PREVIEW)).toHaveLength(0);
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(0);
    await alert.getByRole('link', { name: 'Засах: Зээлийн мэдээлэл' }).click();
    await page.waitForURL(`**/los/loan-application/${APP_ID}/loan`);
    expectClean(guard, api);
  });

  test('нөхцөл бий, орлогын саадтай: slider идэвхгүй, preview явахгүй', async ({ page }) => {
    const overview = emptyOverview({ blockers: [reason('NO_INCOME')] });
    const { api, guard } = await setup(page, { overview });
    await open(page);
    await expect(banner(page, 'Тооцоолол хийх боломжгүй')).toContainText('Засах: Орлого');
    await expect(page.getByRole('slider', { name: 'Зээлийн дүн' })).toHaveAttribute('aria-disabled', 'true');
    await expect(amountInput(page)).toBeDisabled();
    await expect(calculateButton(page)).toBeDisabled();
    await page.waitForTimeout(500);
    expect(api.callsTo('POST', PREVIEW)).toHaveLength(0);
    expectClean(guard, api);
  });
});

test.describe('зөвхөн харах горим (батлагч)', () => {
  test('тооцоолох, сонгох боломжгүй; тайлбар; slider (унших эрх) ажиллана', async ({ page }) => {
    const { api, guard } = await setup(page, { role: 'APPROVER', overview: makeOverview({ editable: false }) });
    await open(page);
    await expect(banner(page, 'Зөвхөн харах горим')).toBeVisible();
    await expect(calculateButton(page)).toBeDisabled();
    await expect(page.getByText('Энэ хүсэлтийн төлөв эсвэл таны эрхээр тооцоолох боломжгүй.')).toBeVisible();
    for (const l of ['A', 'B', 'C'] as const) await expect(methodRadio(page, l)).toBeDisabled();
    await expect(methodRadio(page, 'C')).toBeChecked(); // одоогийн сонголт харагдана
    await expect(page.getByText('Арга сонгох боломжгүй: зөвхөн харах горим.')).toBeVisible();

    await amountInput(page).fill('25000000');
    await expect.poll(() => previewBodies(api)).toEqual([{ amount: 25_000_000, termMonths: 24, interestRate: 23.99 }]);
    await expect(banner(page, 'Урьдчилсан харагдац: хадгалагдаагүй')).toBeVisible();
    expect(api.callsTo('POST', CALCULATE)).toHaveLength(0);
    expect(api.callsTo('PUT', SELECTION)).toHaveLength(0);
    expectClean(guard, api);
  });
});

test.describe('Sosco Score карт', () => {
  test('оноо, зэрэг, хамрах хувь, бүрэлдэхүүн (мэдэгдэхгүй нь тусгай шошготой)', async ({ page }) => {
    const { api, guard } = await setup(page);
    await open(page);
    const card = page.getByRole('region', { name: 'Sosco Score (дотоод)' });
    await expect(card).toContainText('Загвар v3');
    const row = (label: string) => card.getByRole('row').filter({ hasText: label }).last();
    await expect(row('ЗМС / FICO оноо')).toContainText('702');
    await expect(row('ЗМС / FICO оноо')).toContainText('215');
    await expect(row('Өр/орлогын харьцаа (%)')).toContainText('41.3%');
    await expect(row('Хугацаа хэтрэлтийн түүх (сар)')).toContainText('мэдэгдэхгүй');
    await expect(row('ЗМС / FICO оноо').getByRole('progressbar')).toHaveCount(2); // нормчилсон + оноо
    await expect(row('Хугацаа хэтрэлтийн түүх (сар)').getByRole('progressbar')).toHaveCount(0);
    expectClean(guard, api);
  });

  test('INSUFFICIENT_DATA: оноо «—», зэрэг байхгүй, тайлбар', async ({ page }) => {
    const { api, guard } = await setup(page, { overview: makeOverview({ sosco: soscoInsufficient() }) });
    await open(page);
    await expect(page.getByTestId('score-sosco-score')).toHaveText('—');
    await expect(page.locator('[data-grade]')).toHaveCount(0);
    const alert = page.getByRole('alert').filter({ hasText: 'Мэдээлэл хангалтгүй: оноо өгөөгүй' });
    await expect(alert).toContainText('жин 35% байгаа нь оноо гаргахад хүрэлцэхгүй');
    await expect(alert).toContainText('default шатлалаар явна (FR-5.5)');
    expectClean(guard, api);
  });
});

test.describe('утасны дэлгэц (хэвтээ гүйлгэлтгүй)', () => {
  for (const width of [320, 375]) {
    test(`${width}px: хуудас хэвтээ гүйлгэгдэхгүй, хүснэгт карт дотроо гүйлгэгдэнэ`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { api, guard } = await setup(page, {
        overview: makeOverview({ calculation: makeCalculation({ terms: VERDICT_TERMS, inputs: VERDICT_INPUTS, isStale: true, staleReason: 'Зээлийн хүү өөрчлөгдсөн' }), blockers: [reason('NO_INCOME')] }),
        inputs: VERDICT_INPUTS,
      });
      await open(page);
      await expectNoHorizontalScroll(page);
      const table = page.locator('.ant-table-content').first();
      const overflow = await table.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, style: getComputedStyle(el).overflowX }));
      expect(overflow.scroll).toBeGreaterThan(overflow.client); // хүснэгт өөрийн дотор гүйлгэгддэг
      expect(['auto', 'scroll']).toContain(overflow.style);
      // Хүснэгтийн баруун хэсэг рүү гүйлгэхэд хуудас гүйлгэгдэхгүй
      await table.evaluate((el) => (el.scrollLeft = el.scrollWidth));
      await expectNoHorizontalScroll(page);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      expectClean(guard, api);
    });
  }

  test('375px: slider өөрчлөгдсөн (preview), Sosco, барьцаа, stress — хэвтээ гүйлгэлтгүй; товчнууд дэлгэцэнд багтана', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { api, guard } = await setup(page);
    await open(page);
    await amountInput(page).fill('26000000');
    await expect(banner(page, 'Урьдчилсан харагдац: хадгалагдаагүй')).toBeVisible();
    await expect(page.locator('[data-live="monthlyPayment"] dd')).toContainText('₮');
    await expectNoHorizontalScroll(page);
    const box = await calculateButton(page).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    await page.getByRole('region', { name: 'Sosco Score (дотоод)' }).scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    expectClean(guard, api);
  });
});
