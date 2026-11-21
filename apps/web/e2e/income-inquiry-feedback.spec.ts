import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  IncomeManualInput, IncomeOverviewResponse, IncomeSalaryInput, InquiriesResponse, UnregisteredLoanInput,
  type IncomeManualView, type IncomeSalaryView, type UnregisteredLoan,
} from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Орлого, лавлагааны алхмын хариу (naive-user тест F2-12, F2-13, F2-9). Gateway-г mock хийсэн.
const APP_ID = '00000000-0000-4000-8000-0000000000a6';
const CUSTOMER_ID = 'cust-a6-1';
const FUTURE_MONTH_ERROR = 'Ирээдүйн сарын цалин оруулж болохгүй';

const toast = (page: Page, text: string | RegExp) => page.locator('.ant-message-notice-content', { hasText: text });

// ── Орлого (F2-12, F2-13) ──────────────────────────────────────────────────────────────────────────────────────────────────
const SALARIES = '/applications/:id/income/salaries';
const MANUAL = '/applications/:id/income/manual';

interface IncomeState { salaries: IncomeSalaryView[]; manual: IncomeManualView[] }

function incomeView(s: IncomeState): IncomeOverviewResponse {
  return IncomeOverviewResponse.parse({
    borrowers: [{
      customerId: CUSTOMER_ID, role: 'PRIMARY', included: true, displayName: 'Бат Болд', salaries: s.salaries, manual: s.manual, manualMonthlyTotal: s.manual.reduce((sum, m) => sum + m.monthlyAmount, 0),
      summary: { periodFrom: null, periodTo: null, months: null, salaryTotal: null, avgSalaryMonthly: null, businessNcfMonthly: null, householdExpenseMonthly: null, businessExpenseMonthly: null },
      hasIncome: s.salaries.length + s.manual.length > 0, business: { available: false, message: 'BSA нэгтгэл хараахан байхгүй' },
    }],
    blockers: [], step: { status: 'PENDING', reason: null },
  });
}

/** Жинхэнэ сервер шиг: ирээдүй сарын цалинг 422 `INVALID_PERIOD`-оор буцаана (income.service.ts). */
const isFuture = (year: number, month: number): boolean => year * 12 + month > 2026 * 12 + 11;

async function setupIncome(page: Page) {
  const api = new MockApi('OFFICER');
  const state: IncomeState = { salaries: [], manual: [] };
  api.get('/applications/:id/income', () => ({ json: incomeView(state) }));
  api.post(SALARIES, ({ body }) => {
    const input = IncomeSalaryInput.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    const { year, month, salary, employer } = input.data;
    if (isFuture(year, month)) return { status: 422, json: { code: 'INVALID_PERIOD', message: FUTURE_MONTH_ERROR } };
    state.salaries = [...state.salaries, { id: `sal-${state.salaries.length + 1}`, employer: employer ?? null, year, month, salary, contributionPaid: null, source: 'MANUAL' }];
    return { status: 201, json: incomeView(state) };
  });
  api.post(MANUAL, ({ body }) => {
    const input = IncomeManualInput.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    state.manual = [...state.manual, { id: `man-${state.manual.length + 1}`, type: input.data.type, monthlyAmount: input.data.monthlyAmount, fileId: null, note: input.data.note ?? null }];
    return { status: 201, json: incomeView(state) };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, state };
}

const monthPicker = (page: Page) => page.getByPlaceholder('Он-сар', { exact: true });
const employer = (page: Page) => page.getByPlaceholder('Ажил олгогч', { exact: true });
const salaryAmount = (page: Page) => page.getByPlaceholder('Цалин', { exact: true });
const addSalaryButton = (page: Page) => page.getByRole('button', { name: 'Гар цалин нэмэх' });
const manualAmount = (page: Page) => page.getByPlaceholder('Сарын дүн', { exact: true });
const manualNote = (page: Page) => page.getByPlaceholder('Тайлбар', { exact: true });
const addManualButton = (page: Page) => page.getByRole('button', { name: 'Нэмэх', exact: true });
const salaryErrorBox = (page: Page) => page.getByTestId('income-salary-error');

async function pickMonth(page: Page, ym: string) {
  await monthPicker(page).fill(ym);
  await page.keyboard.press('Enter');
}

async function openIncome(page: Page) {
  const ctx = await setupIncome(page);
  await page.goto(`/los/loan-application/${APP_ID}/income`);
  await expect(monthPicker(page)).toBeVisible();
  return ctx;
}

/** Товчийг цонхны ХАМГИЙН ДООД ирмэгт тавина — хэрэглэгч формыг доод ирмэгт нь байхад алдаа гарвал юу харагдахыг дууриана. */
const parkAtBottomEdge = (button: Locator) => button.evaluate((el) => el.scrollIntoView({ block: 'end' }));

test.describe('F2-12: ирээдүй сарын цалингийн серверийн алдаа формын дэргэд харагдана', () => {
  test.use({ viewport: { width: 1280, height: 560 } });

  test('the 422 message appears right under the submit button, inside the visible window, and nowhere else', async ({ page }) => {
    const { api, guard } = await openIncome(page);
    await pickMonth(page, '2027-12');
    await salaryAmount(page).fill('1500000');
    await parkAtBottomEdge(addSalaryButton(page));
    await addSalaryButton(page).click();

    const error = salaryErrorBox(page).getByRole('alert');
    await expect(error).toContainText(FUTURE_MONTH_ERROR);
    await expect(error).toBeInViewport({ ratio: 1 });
    const button = (await addSalaryButton(page).boundingBox())!;
    const box = (await error.boundingBox())!;
    expect(box.y, 'alert starts below the submit button').toBeGreaterThanOrEqual(button.y + button.height);
    expect(box.y - (button.y + button.height), 'alert is adjacent to the form').toBeLessThan(80);
    await expect(page.getByRole('alert').filter({ hasText: FUTURE_MONTH_ERROR })).toHaveCount(1);
    expect(api.callsTo('POST', SALARIES)).toHaveLength(1);
    expectClean(guard, api);
  });

  test('the values the user typed stay in the form so they can fix the month and resubmit', async ({ page }) => {
    await openIncome(page);
    await pickMonth(page, '2027-12');
    await employer(page).fill('Монгол ХХК');
    await salaryAmount(page).fill('1500000');
    await addSalaryButton(page).click();
    await expect(salaryErrorBox(page)).toContainText(FUTURE_MONTH_ERROR);
    await expect(monthPicker(page)).toHaveValue('2027-12');
    await expect(employer(page)).toHaveValue('Монгол ХХК');
    await expect(salaryAmount(page)).toHaveValue('1,500,000');
    await expect(toast(page, 'Цалин нэмэгдлээ')).toHaveCount(0);
  });
});

test.describe('F2-13: орлого амжилттай нэмэгдсний дараа форм цэвэрлэгдэж, мэдэгдэл гарна', () => {
  test('a manual salary: success toast, new table row, and month/employer/amount are cleared', async ({ page }) => {
    const { api, state, guard } = await openIncome(page);
    await pickMonth(page, '2026-11');
    await employer(page).fill('Монгол ХХК');
    await salaryAmount(page).fill('1500000');
    await addSalaryButton(page).click();

    await expect(toast(page, 'Цалин нэмэгдлээ')).toBeVisible();
    await expect(page.getByRole('row', { name: /2026-11.*Монгол ХХК/ })).toBeVisible();
    await expect(monthPicker(page)).toHaveValue('');
    await expect(employer(page)).toHaveValue('');
    await expect(salaryAmount(page)).toHaveValue('');
    expect(state.salaries).toHaveLength(1);
    expect(api.callsTo('POST', SALARIES)).toHaveLength(1);
    expectClean(guard, api);
  });

  test('a manual income: success toast, new table row, and amount/note are cleared', async ({ page }) => {
    const { api, state } = await openIncome(page);
    await manualAmount(page).fill('800000');
    await manualNote(page).fill('Орон сууцны түрээс');
    await addManualButton(page).click();

    await expect(toast(page, 'Орлого нэмэгдлээ')).toBeVisible();
    await expect(page.getByRole('row', { name: /Түрээс.*Орон сууцны түрээс/ })).toBeVisible();
    await expect(manualAmount(page)).toHaveValue('');
    await expect(manualNote(page)).toHaveValue('');
    expect(state.manual).toHaveLength(1);
    expect(api.callsTo('POST', MANUAL)).toHaveLength(1);
  });
});

// ── Лавлагаа · ЗМС-д бүртгэлгүй зээл (F2-9) ────────────────────────────────────────────────────────────────────────────────
const LOANS = '/applications/:id/inquiries/unregistered-loans';
const FETCH = '/applications/:id/inquiries/fetch';
const FETCH_FAILURE = { customerId: CUSTOMER_ID, source: 'CIB', code: 'INQUIRY_UNAVAILABLE', message: 'CIB түр ажиллахгүй' };

function inquiryView(loans: UnregisteredLoan[], failures: unknown[] = []): InquiriesResponse {
  return InquiriesResponse.parse({
    staleDays: 30, complete: false, step: { status: 'PENDING', reason: 'INQUIRY_MISSING' }, failures,
    borrowers: [{ customerId: CUSTOMER_ID, role: 'PRIMARY', displayName: 'Бат Болд', registerNoMasked: 'УБ****78', complete: false, hasStale: false, missing: [], items: [], unregisteredLoans: loans, monthlyDebtPayment: loans.reduce((s, l) => s + l.monthlyPayment, 0) }],
  });
}

/** Сервер шиг: `failures` нь ЗӨВХӨН татах (POST fetch) хариунд; жагсаалтын GET үргэлж хоосон `failures` буцаана. */
async function setupInquiry(page: Page, init: { fetchFailures?: unknown[] } = {}) {
  const api = new MockApi('OFFICER');
  const state = { loans: [] as UnregisteredLoan[] };
  api.get('/applications/:id/inquiries', () => ({ json: inquiryView(state.loans) }));
  api.post(FETCH, () => ({ json: inquiryView(state.loans, init.fetchFailures ?? []) }));
  api.post(LOANS, ({ body }) => {
    const input = UnregisteredLoanInput.safeParse(body);
    if (!input.success) return { status: 400, json: { code: 'VALIDATION_FAILED', message: 'invalid' } };
    const loan: UnregisteredLoan = { id: `loan-${state.loans.length + 1}`, customerId: CUSTOMER_ID, lenderName: input.data.lenderName, amount: input.data.amount, monthlyPayment: input.data.monthlyPayment, note: input.data.note ?? null };
    state.loans = [...state.loans, loan];
    return { status: 201, json: loan };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, state };
}

const lender = (page: Page) => page.getByPlaceholder('Зээлдүүлэгч', { exact: true });
const addLoan = (page: Page) => page.getByRole('button', { name: 'Бүртгэлгүй зээл нэмэх' });
const fetchAll = (page: Page) => page.getByRole('button', { name: 'Бүгдийг татах' });
const EMPTY_LOANS = 'Бүртгэлгүй зээл байхгүй';

async function openInquiry(page: Page, init: Parameters<typeof setupInquiry>[1] = {}) {
  const ctx = await setupInquiry(page, init);
  await page.goto(`/los/loan-application/${APP_ID}/inquiry`);
  await expect(lender(page)).toBeVisible();
  return ctx;
}

async function addBankLoan(page: Page, name: string) {
  await lender(page).fill(name);
  await page.getByPlaceholder('Зээлийн дүн', { exact: true }).fill('5000000');
  await page.getByPlaceholder('Сарын төлбөр', { exact: true }).fill('250000');
  await addLoan(page).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
}

test.describe('F2-9: бүртгэлгүй зээл нэмсний дараа жагсаалт шинэчлэгдэнэ', () => {
  test('adding the first loan on an empty list shows it without a reload', async ({ page }) => {
    const { api, guard } = await openInquiry(page);
    await expect(page.getByText(EMPTY_LOANS)).toBeVisible();
    await addBankLoan(page, 'Хаан банк');
    await expect(page.getByRole('row', { name: /Хаан банк/ })).toBeVisible();
    await expect(page.getByText(EMPTY_LOANS)).toHaveCount(0);
    expectClean(guard, api);
  });

  test('after «Бүгдийг татах» the first added loan still shows up (the fetch result must not freeze the list)', async ({ page }) => {
    const { api } = await openInquiry(page);
    await fetchAll(page).click();
    await expect(toast(page, 'Лавлагаа татагдлаа')).toBeVisible();
    await addBankLoan(page, 'Хаан банк');
    await expect(page.getByRole('row', { name: /Хаан банк/ })).toBeVisible();
    await expect(page.getByText(EMPTY_LOANS)).toHaveCount(0);
    expect(api.callsTo('POST', FETCH)).toHaveLength(1);
  });

  test('a second loan added after a fetch shows up too', async ({ page }) => {
    await openInquiry(page);
    await fetchAll(page).click();
    await expect(toast(page, 'Лавлагаа татагдлаа')).toBeVisible();
    await addBankLoan(page, 'Хаан банк');
    await expect(page.getByRole('row', { name: /Хаан банк/ })).toBeVisible();
    await addBankLoan(page, 'Голомт банк');
    await expect(page.getByRole('row', { name: /Голомт банк/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Хаан банк/ })).toBeVisible();
  });

  test('fetch failures stay visible after a loan is added (they only exist in the fetch response)', async ({ page }) => {
    await openInquiry(page, { fetchFailures: [FETCH_FAILURE] });
    await fetchAll(page).click();
    const failures = page.getByRole('alert').filter({ hasText: 'Зарим лавлагааг татаж чадсангүй' });
    await expect(failures).toContainText('CIB түр ажиллахгүй');
    await addBankLoan(page, 'Хаан банк');
    await expect(page.getByRole('row', { name: /Хаан банк/ })).toBeVisible();
    await expect(failures).toContainText('CIB түр ажиллахгүй');
  });
});
