import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  IncomeExpensesBody, IncomeManualInput, IncomeOverviewResponse, IncomeSalaryInput, InquiriesResponse, LoanProductsResponse, LoanTermsView, PricingQuoteResponse, SaveLoanTermsRequest,
  UnregisteredLoanInput, type IncomeManualView, type IncomeSalaryView, type UnregisteredLoan,
} from '@los/contracts';
import { guardConsole, MockApi, type MockRequest } from './mock-api';

// Wizard-ийн мөнгөн/хувийн оролтууд: F2-8 / F2-8b (чимээгүй тасалдаг InputNumber), F2-17 (шимтгэл бутархайгаар), F2-14 (давхар нэмэлт). Gateway-г mock хийсэн.
// Бүх assertion нь серверт ХЭРЭГЛЭГЧИЙН ХҮССЭН утга очсон эсэх, эсвэл талбарт алдаа гарч юу ч явсангүй эсэх дээр.
const APP_ID = '00000000-0000-4000-8000-0000000000f2';
const CUSTOMER_ID = 'cust-f2-1';
const NOT_A_NUMBER = 'Зөвхөн тоо оруулна уу';
const NEGATIVE = 'Сөрөг дүн оруулах боломжгүй';
const NOT_POSITIVE = 'Дүн 0-ээс их байх ёстой';

/**
 * Хоёр дахь дарилт нь эхнийхээ хүсэлт эхэлсний ДАРАА, гэхдээ React "loading"-ийг дахин зурахаас ӨМНӨ ирнэ: TanStack mutation-ий төлөвийг дараагийн timer-т (setTimeout 0) мэдэгддэг.
 * Нэг JS task дотор хоёр дарилт хийвэл rc-field-form эхний шалгалтыг хаядаг (зөвхөн сүүлийнх нь onFinish дууддаг) тул тэр нь давхар илгээлтийг үзүүлдэггүй.
 * Манай timer нь TanStack-ийнхээс өмнө бүртгэгддэг тул дараалал тогтмол (deterministic).
 */
const clickAgainBeforeRerender = (button: Locator) => button.evaluate(async (el: HTMLElement) => {
  el.click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  el.click();
});

// ── Лавлагаа · ЗМС-д бүртгэлгүй зээл (F2-8) ────────────────────────────────────────────────────────────────────────────────
const LOANS = '/applications/:id/inquiries/unregistered-loans';

function inquiryView(loans: UnregisteredLoan[]): InquiriesResponse {
  return InquiriesResponse.parse({
    staleDays: 30, complete: false, step: { status: 'PENDING', reason: 'INQUIRY_MISSING' }, failures: [],
    borrowers: [{ customerId: CUSTOMER_ID, role: 'PRIMARY', displayName: 'Бат Болд', registerNoMasked: 'УБ****78', complete: false, hasStale: false, missing: [], items: [], unregisteredLoans: loans, monthlyDebtPayment: loans.reduce((s, l) => s + l.monthlyPayment, 0) }],
  });
}

async function setupInquiry(page: Page) {
  const api = new MockApi('OFFICER');
  const state = { loans: [] as UnregisteredLoan[] };
  api.get('/applications/:id/inquiries', () => ({ json: inquiryView(state.loans) }));
  api.post(LOANS, ({ body }) => {
    const input = UnregisteredLoanInput.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    const loan: UnregisteredLoan = { id: `loan-${state.loans.length + 1}`, customerId: CUSTOMER_ID, lenderName: input.data.lenderName, amount: input.data.amount, monthlyPayment: input.data.monthlyPayment, note: input.data.note ?? null };
    state.loans = [...state.loans, loan];
    return { status: 201, json: loan };
  });
  await api.install(page);
  guardConsole(page);
  return { api };
}

const lender = (page: Page) => page.getByPlaceholder('Зээлдүүлэгч', { exact: true });
const loanAmount = (page: Page) => page.getByPlaceholder('Зээлийн дүн', { exact: true });
const loanMonthly = (page: Page) => page.getByPlaceholder('Сарын төлбөр', { exact: true });
const addLoan = (page: Page) => page.getByRole('button', { name: 'Бүртгэлгүй зээл нэмэх' });
const loanPosts = (api: MockApi): MockRequest[] => api.callsTo('POST', LOANS);

test.describe('F2-8: ЗМС-д бүртгэлгүй зээлийн мөнгөн оролт', () => {
  const open = async (page: Page) => {
    const { api } = await setupInquiry(page);
    await page.goto(`/los/loan-application/${APP_ID}/inquiry`);
    await expect(lender(page)).toBeVisible();
    return api;
  };

  test('digits are shown with thousand separators while typing', async ({ page }) => {
    await open(page);
    await loanAmount(page).fill('1234567');
    await expect(loanAmount(page)).toHaveValue('1,234,567');
  });

  test('typing digit by digit regroups the separators and an edit in the middle keeps the caret in place', async ({ page }) => {
    await open(page);
    const input = loanAmount(page);
    await input.click();
    await input.pressSequentially('1234567');
    await expect(input).toHaveValue('1,234,567');
    await input.press('Home');
    for (let i = 0; i < 3; i++) await input.press('ArrowRight'); // "1,2|34,567"
    await input.press('9'); // 1,2934,567 → 12,934,567: курсор "9"-ийн ард үлдэнэ
    await input.press('0'); // курсор төгсгөл рүү үсэрсэн бол 129,345,670 болно
    await expect(input).toHaveValue('129,034,567');
  });

  test('"5сая" and "500мянга" are understood and sent as 5,000,000 and 500,000', async ({ page }) => {
    const api = await open(page);
    await lender(page).fill('Хаан банк');
    await loanAmount(page).fill('5сая');
    await loanMonthly(page).fill('500мянга');
    await addLoan(page).click();
    await expect(page.getByText('Бүртгэлгүй зээл нэмэгдлээ')).toBeVisible();
    expect(loanPosts(api)).toHaveLength(1);
    expect(loanPosts(api)[0]!.body).toMatchObject({ lenderName: 'Хаан банк', amount: 5_000_000, monthlyPayment: 500_000 });
  });

  test('pasted values with commas or spaces keep their value', async ({ page }) => {
    const api = await open(page);
    await lender(page).fill('Хаан банк');
    await loanAmount(page).fill('5,000,000');
    await loanMonthly(page).fill('1 500 000');
    await expect(loanAmount(page)).toHaveValue('5,000,000');
    await expect(loanMonthly(page)).toHaveValue('1,500,000');
    await addLoan(page).click();
    await expect(page.getByText('Бүртгэлгүй зээл нэмэгдлээ')).toBeVisible();
    expect(loanPosts(api)[0]!.body).toMatchObject({ amount: 5_000_000, monthlyPayment: 1_500_000 });
  });

  test('a negative amount is rejected with a field error and nothing is sent (no silent 0)', async ({ page }) => {
    const api = await open(page);
    await lender(page).fill('Хаан банк');
    await loanAmount(page).fill('1000000');
    await loanMonthly(page).fill('-100');
    await addLoan(page).click();
    await expect(page.getByText(NEGATIVE)).toBeVisible();
    expect(loanPosts(api)).toHaveLength(0);
  });

  test('text that is not a number is rejected with a message instead of being stripped', async ({ page }) => {
    const api = await open(page);
    await lender(page).fill('Хаан банк');
    await loanAmount(page).fill('тав');
    await loanMonthly(page).fill('100000');
    await addLoan(page).click();
    await expect(page.getByText(NOT_A_NUMBER)).toBeVisible();
    expect(loanPosts(api)).toHaveLength(0);
  });
});

// ── Орлого (F2-8b, F2-14) ───────────────────────────────────────────────────────────────────────────────────────────────────
const SALARIES = '/applications/:id/income/salaries';
const MANUAL = '/applications/:id/income/manual';
const EXPENSES = '/applications/:id/income/expenses/:customerId';

interface IncomeState { salaries: IncomeSalaryView[]; manual: IncomeManualView[]; household: number | null; business: number | null; conflict: { code: string; message: string } | null }

function incomeView(s: IncomeState): IncomeOverviewResponse {
  return IncomeOverviewResponse.parse({
    borrowers: [{
      customerId: CUSTOMER_ID, role: 'PRIMARY', included: true, displayName: 'Бат Болд', salaries: s.salaries, manual: s.manual, manualMonthlyTotal: s.manual.reduce((sum, m) => sum + m.monthlyAmount, 0),
      summary: { periodFrom: null, periodTo: null, months: null, salaryTotal: null, avgSalaryMonthly: null, businessNcfMonthly: null, householdExpenseMonthly: s.household, businessExpenseMonthly: s.business },
      hasIncome: s.salaries.length + s.manual.length > 0, business: { available: false, message: 'BSA нэгтгэл хараахан байхгүй' },
    }],
    blockers: [], step: { status: 'PENDING', reason: null },
  });
}

async function setupIncome(page: Page, init: { conflict?: IncomeState['conflict']; postDelayMs?: number } = {}) {
  const api = new MockApi('OFFICER');
  const state: IncomeState = { salaries: [], manual: [], household: null, business: null, conflict: init.conflict ?? null };
  api.get('/applications/:id/income', () => ({ json: incomeView(state) }));
  api.post(SALARIES, ({ body }) => {
    if (state.conflict) return { status: 409, json: state.conflict };
    const input = IncomeSalaryInput.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    const { year, month, salary, employer } = input.data;
    // Жинхэнэ сервер шиг: ижил сарын гар цалинг дахин хүлээж авахгүй
    if (state.salaries.some((r) => r.source === 'MANUAL' && r.year === year && r.month === month)) return { status: 409, json: { code: 'SALARY_MONTH_DUPLICATE', message: `${year}-${String(month).padStart(2, '0')} сарын цалин аль хэдийн гараар нэмэгдсэн байна` } };
    state.salaries = [...state.salaries, { id: `sal-${state.salaries.length + 1}`, employer: employer ?? null, year, month, salary, contributionPaid: null, source: 'MANUAL' }];
    return { status: 201, json: incomeView(state), delayMs: init.postDelayMs };
  });
  api.post(MANUAL, ({ body }) => {
    const input = IncomeManualInput.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    state.manual = [...state.manual, { id: `man-${state.manual.length + 1}`, type: input.data.type, monthlyAmount: input.data.monthlyAmount, fileId: null, note: input.data.note ?? null }];
    return { status: 201, json: incomeView(state) };
  });
  api.put(EXPENSES, ({ body }) => {
    const input = IncomeExpensesBody.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    state.household = input.data.householdExpenseMonthly ?? state.household;
    state.business = input.data.businessExpenseMonthly ?? state.business;
    return { json: incomeView(state) };
  });
  await api.install(page);
  guardConsole(page);
  return { api, state };
}

const monthPicker = (page: Page) => page.getByPlaceholder('Он-сар', { exact: true });
const salaryAmount = (page: Page) => page.getByPlaceholder('Цалин', { exact: true });
const addSalaryButton = (page: Page) => page.getByRole('button', { name: 'Гар цалин нэмэх' });
const manualAmount = (page: Page) => page.getByPlaceholder('Сарын дүн', { exact: true });
const addManualButton = (page: Page) => page.getByRole('button', { name: 'Нэмэх', exact: true });
const household = (page: Page) => page.getByPlaceholder('Өрхийн сарын зардал', { exact: true });
const business = (page: Page) => page.getByPlaceholder('Бизнесийн сарын зардал', { exact: true });
const saveExpenses = (page: Page) => page.getByRole('button', { name: 'Хадгалах', exact: true });

async function pickMonth(page: Page, ym: string) {
  await monthPicker(page).fill(ym);
  await page.keyboard.press('Enter');
}
const salaryErrorBox = (page: Page) => page.getByTestId('income-salary-error');

test.describe('F2-8b: орлого, зардлын мөнгөн оролт', () => {
  const open = async (page: Page, init: Parameters<typeof setupIncome>[1] = {}) => {
    const ctx = await setupIncome(page, init);
    await page.goto(`/los/loan-application/${APP_ID}/income`);
    await expect(household(page)).toBeVisible();
    return ctx;
  };

  test('"2сая" household expense is saved as 2,000,000 (not 2)', async ({ page }) => {
    const { api } = await open(page);
    await household(page).fill('2сая');
    await saveExpenses(page).click();
    await expect.poll(() => api.callsTo('PUT', EXPENSES).length).toBe(1);
    expect(api.callsTo('PUT', EXPENSES)[0]!.body).toMatchObject({ householdExpenseMonthly: 2_000_000 });
  });

  test('a negative business expense is rejected with a field error and nothing is saved (no silent 0)', async ({ page }) => {
    const { api } = await open(page);
    await household(page).fill('1500000');
    await business(page).fill('-50');
    await saveExpenses(page).click();
    await expect(page.getByText(NEGATIVE)).toBeVisible();
    expect(api.callsTo('PUT', EXPENSES)).toHaveLength(0);
  });

  test('a manual income of 0 is rejected as not greater than zero', async ({ page }) => {
    const { api } = await open(page);
    await manualAmount(page).fill('0');
    await addManualButton(page).click();
    await expect(page.getByText(NOT_POSITIVE)).toBeVisible();
    expect(api.callsTo('POST', MANUAL)).toHaveLength(0);
  });

  test('a manual income of "500мянга" is saved as 500,000', async ({ page }) => {
    const { api } = await open(page);
    await manualAmount(page).fill('500мянга');
    await addManualButton(page).click();
    await expect.poll(() => api.callsTo('POST', MANUAL).length).toBe(1);
    expect(api.callsTo('POST', MANUAL)[0]!.body).toMatchObject({ monthlyAmount: 500_000 });
  });
});

test.describe('F2-14: гар цалинг давхар нэмэх', () => {
  const open = async (page: Page, init: Parameters<typeof setupIncome>[1] = {}) => {
    const ctx = await setupIncome(page, init);
    await page.goto(`/los/loan-application/${APP_ID}/income`);
    await expect(monthPicker(page)).toBeVisible();
    return ctx;
  };

  test('a second click before the first request has re-rendered the button sends the salary once', async ({ page }) => {
    const { api, state } = await open(page, { postDelayMs: 400 });
    await pickMonth(page, '2026-11');
    await salaryAmount(page).fill('1500000');
    await clickAgainBeforeRerender(addSalaryButton(page));
    await expect.poll(() => state.salaries.length).toBe(1);
    await page.waitForTimeout(600); // хоёр дахь хүсэлт хоцорч ирэх боломжийг хүлээнэ
    expect(api.callsTo('POST', SALARIES)).toHaveLength(1);
    expect(state.salaries).toHaveLength(1);
  });

  test('the add button is disabled while the request is pending', async ({ page }) => {
    await open(page, { postDelayMs: 600 });
    await pickMonth(page, '2026-10');
    await salaryAmount(page).fill('1200000');
    await addSalaryButton(page).click();
    await expect(addSalaryButton(page)).toBeDisabled();
    await expect(addSalaryButton(page)).toBeEnabled();
  });

  test('after a successful add the form is cleared, so the same row is not re-added by accident', async ({ page }) => {
    const { api } = await open(page);
    await pickMonth(page, '2026-09');
    await salaryAmount(page).fill('1 800 000');
    await addSalaryButton(page).click();
    await expect(page.locator('tr', { hasText: '2026-09' })).toContainText('1,800,000₮');
    await expect(monthPicker(page)).toHaveValue('');
    await expect(salaryAmount(page)).toHaveValue('');
    await addSalaryButton(page).click(); // хоосон форм дахин илгээгдэхгүй, "Заавал бөглөнө" гарна
    await expect(page.getByText('Заавал бөглөнө').first()).toBeVisible();
    expect(api.callsTo('POST', SALARIES)).toHaveLength(1);
  });

  for (const c of [
    { code: 'SALARY_MONTH_DUPLICATE', message: '2026-11 сарын цалин аль хэдийн гараар нэмэгдсэн байна' },
    { code: 'SALARY_MONTH_IN_NDSH', message: '2026-11 сарын цалин НДШ-ээс татагдсан байна, гараар нэмэх шаардлагагүй' },
  ]) {
    test(`the server's 409 ${c.code} message is shown in the salary form, and the typed values stay`, async ({ page }) => {
      await open(page, { conflict: c });
      await pickMonth(page, '2026-11');
      await salaryAmount(page).fill('1500000');
      await addSalaryButton(page).click();
      await expect(salaryErrorBox(page)).toContainText(c.message);
      await expect(salaryAmount(page)).toHaveValue('1,500,000');
      await expect(addSalaryButton(page)).toBeEnabled();
    });
  }
});

// ── Зээлийн нөхцөл (F2-8 дүн, F2-17 шимтгэл) ────────────────────────────────────────────────────────────────────────────────
const TERMS = '/applications/:id/loan-terms';
const LIMITS = { minAmount: 100_000, maxAmount: 50_000_000, minTermMonths: 3, maxTermMonths: 36, minRate: 10, maxRate: 48, defaultFeeRate: 0.01 };

function termsView(o: Partial<LoanTermsView> = {}): LoanTermsView {
  return LoanTermsView.parse({
    applicationId: APP_ID, editable: true, productId: 'prod-cons', currency: 'MNT', amount: 5_000_000, termMonths: 12, interestRate: 24, feeRate: 0.015, feeAmount: 75_000,
    downPayment: null, charges: null, insurance: null, purpose: 'Хэрэглээний хэрэгцээ', purposeDetail: null, cibPurposeCode: null, cibSubCode: null, officerNote: null,
    limits: LIMITS, step: { status: 'PENDING', staleReason: null }, installmentStep: null, soscoScore: null, ...o,
  });
}

const QUOTE = PricingQuoteResponse.parse({
  basis: 'SCORE', soscoScore: 700, tier: { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650 }, tierInterestRate: 22, tierFeeRate: 0.0125, interestRate: 22, feeRate: 0.0125, rateBound: null, feeAmount: 62_500,
  productRateBounds: { minRate: 10, maxRate: 48 }, config: { scope: 'DEFAULT', productId: null, version: 1 },
});

async function setupTerms(page: Page, initial: Partial<LoanTermsView> = {}) {
  const api = new MockApi('OFFICER');
  const state = { view: termsView(initial) };
  api.get(TERMS, () => ({ json: state.view }));
  api.get('/loan-terms/products', { json: LoanProductsResponse.parse({ items: [{ id: 'prod-cons', code: 'CONS', name: 'Хэрэглээний зээл', productType: 'CONSUMER', currency: 'MNT', requiresCollateral: false, limits: LIMITS }] }) });
  api.get('/loan-terms/cib-purposes', { json: { items: [] } });
  api.post('/loan-terms/pricing/quote', { json: QUOTE });
  api.put(TERMS, ({ body }) => {
    const req = SaveLoanTermsRequest.safeParse(body);
    if (!req.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    state.view = termsView({ ...state.view, ...req.data, feeAmount: req.data.amount * (req.data.feeRate ?? 0) });
    return { json: state.view };
  });
  await api.install(page);
  guardConsole(page);
  return { api, state };
}

const termsAmount = (page: Page) => page.getByTestId('terms-amount');
const termsFee = (page: Page) => page.getByLabel('Шимтгэлийн хувь');
const termsSave = (page: Page) => page.getByTestId('terms-save');
const termsPuts = (api: MockApi): MockRequest[] => api.callsTo('PUT', TERMS);

test.describe('F2-8: зээлийн дүн', () => {
  const open = async (page: Page) => {
    const ctx = await setupTerms(page);
    await page.goto(`/los/loan-application/${APP_ID}/loan`);
    await expect(termsAmount(page)).toBeVisible();
    return ctx;
  };

  test('the saved amount is shown with thousand separators', async ({ page }) => {
    await open(page);
    await expect(termsAmount(page)).toHaveValue('5,000,000');
  });

  test('"7сая" is understood and saved as 7,000,000', async ({ page }) => {
    const { api } = await open(page);
    await termsAmount(page).fill('7сая');
    await termsSave(page).click();
    await expect(page.getByText('Зээлийн нөхцөл хадгалагдлаа')).toBeVisible();
    expect(termsPuts(api)).toHaveLength(1);
    expect(termsPuts(api)[0]!.body).toMatchObject({ amount: 7_000_000 });
  });

  test('a negative amount is rejected and not saved as 0', async ({ page }) => {
    const { api } = await open(page);
    await termsAmount(page).fill('-100');
    await termsSave(page).click();
    await expect(page.getByText(NEGATIVE)).toBeVisible();
    expect(termsPuts(api)).toHaveLength(0);
  });

  test('an amount of 0 is rejected as not greater than zero', async ({ page }) => {
    const { api } = await open(page);
    await termsAmount(page).fill('0');
    await termsSave(page).click();
    await expect(page.getByText('Зээлийн дүн 0-ээс их байх ёстой')).toBeVisible();
    expect(termsPuts(api)).toHaveLength(0);
  });
});

test.describe('F2-17: шимтгэлийн хувь', () => {
  const open = async (page: Page) => {
    const ctx = await setupTerms(page);
    await page.goto(`/los/loan-application/${APP_ID}/loan`);
    await expect(termsFee(page)).toBeVisible();
    return ctx;
  };

  test('the stored fraction 0.015 is shown as 1.5 (percent)', async ({ page }) => {
    await open(page);
    await expect(termsFee(page)).toHaveValue('1.5');
  });

  test('typing "2.5" saves the fraction 0.025, not a clamped 1', async ({ page }) => {
    const { api } = await open(page);
    await termsFee(page).fill('2.5');
    await termsSave(page).click();
    await expect(page.getByText('Зээлийн нөхцөл хадгалагдлаа')).toBeVisible();
    expect(termsPuts(api)).toHaveLength(1);
    expect(termsPuts(api)[0]!.body).toMatchObject({ feeRate: 0.025 });
  });

  test('a fee above 100% is rejected with a message instead of being clamped', async ({ page }) => {
    const { api } = await open(page);
    await termsFee(page).fill('150');
    await termsSave(page).click();
    await expect(page.getByText('Шимтгэлийн хувь 0–100% хооронд байх ёстой')).toBeVisible();
    expect(termsPuts(api)).toHaveLength(0);
  });

  test('a fee with more than 2 decimals is rejected instead of being rounded silently', async ({ page }) => {
    const { api } = await open(page);
    await termsFee(page).fill('1.555');
    await termsSave(page).click();
    await expect(page.getByText('Бутархай хэсэг 2 оронгоос ихгүй байх ёстой')).toBeVisible();
    expect(termsPuts(api)).toHaveLength(0);
  });

  test('"Хүү санал болгох" fills the fee in percent, matching the suggestion text', async ({ page }) => {
    await open(page);
    await page.getByTestId('terms-suggest-rate').click();
    await expect(page.getByTestId('rate-suggestion-fee')).toContainText('1.25%');
    await expect(termsFee(page)).toHaveValue('1.25');
  });
});
