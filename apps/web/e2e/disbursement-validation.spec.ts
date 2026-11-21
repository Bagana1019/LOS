import { expect, test, type Page } from '@playwright/test';
import { DisbursementView, UpdateDisbursementRequest } from '@los/contracts';
import { guardConsole, MockApi, type MockReply } from './mock-api';

// Олголтын маягтын шалгалт (`/los/loan-application/:id/disburse`, FR-12). Gateway-г mock хийсэн.
// F5-4: серверийн алдаа англи zod текст + camelCase нэртэй toast болж, талбарт тэмдэглэгддэггүй байсан.
// F5-5: дансны дугаарт үсэг/зай, нэрэнд emoji/`<script>` хадгалагддаг байсан.
// F5-16: дүнгийн "-5" / "5сая" чимээгүй засагдаж (5 болж), хэт их дүн клиентэд шалгагддаггүй байсан.
const APP_ID = '00000000-0000-4000-8000-0000000000d6';
const URL = `/los/loan-application/${APP_ID}/disburse`;
const DISBURSEMENT = '/applications/:id/disbursement';
const APPROVED = 5_000_000;

const SAVED_TOAST = 'Олголтын мэдээлэл хадгалагдлаа';
const FORM_INVALID = 'Олголтын мэдээлэлд алдаа байна. Улаанаар тэмдэглэсэн талбарыг засаад дахин хадгална уу.';
const ACCOUNT_SERVER_MIN = 'Дансны дугаар хамгийн багадаа 4 тэмдэгт байх ёстой';
const ACCOUNT_LENGTH = 'Дансны дугаар 4–34 цифртэй байх ёстой';
const ACCOUNT_DIGITS = 'Дансны дугаарт зөвхөн цифр бичнэ (үсэг, зай, тусгай тэмдэгтгүй)';
const HOLDER_CHARS = 'Эзэмшигчийн нэрэнд emoji болон < > & тэмдэгт оруулж болохгүй';
const AMOUNT_POSITIVE = 'Олгох дүн 0-ээс их байх ёстой';
const AMOUNT_NOT_NUMBER = 'Олгох дүнд зөвхөн тоо бичнэ (жишээ нь 5000000). Үсэг болон бусад тэмдэг оруулж болохгүй.';
const AMOUNT_MAX = 'Олгох дүн батлагдсан дүнгээс (5,000,000₮) хэтэрч болохгүй';
const SERVER_ENGLISH = /accountNo|holderName|disburseAmount|String must contain|Invalid enum/;

function makeView(o: Partial<DisbursementView> = {}): DisbursementView {
  return DisbursementView.parse({
    id: 'dsb-1', applicationId: APP_ID, applicationStatus: 'APPROVED', status: 'DRAFT', approvedAmount: APPROVED, disburseAmount: APPROVED, termMonths: 12, interestRate: 28,
    repaymentType: 'ANNUITY', firstPaymentDate: '2027-01-05', disburseDate: '2026-12-05', bankCode: 'KHAN', accountNoMasked: '****5678', holderName: 'Номин Дашдорж',
    accountOwnerType: 'SELF', nameCheck: null, reconciliation: null, coreLoanId: null, checks: [], canSubmit: false, history: [], ...o,
  });
}

/** `putReply` өгвөл PUT түүгээр (серверийн алдаа) хариулна; үгүй бол жинхэнэ сервер шиг ирсэн талбарыг хадгална. */
async function setup(page: Page, putReply?: MockReply) {
  const api = new MockApi('OFFICER');
  const state = { view: makeView() };
  api.get(DISBURSEMENT, () => ({ json: state.view }));
  api.put(DISBURSEMENT, ({ body }) => {
    if (putReply) return putReply;
    const req = UpdateDisbursementRequest.parse(body);
    state.view = makeView({ ...state.view, ...req, ...(req.accountNo ? { accountNoMasked: `****${req.accountNo.slice(-4)}` } : {}) });
    return { json: state.view };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, state };
}

const amount = (page: Page) => page.getByTestId('disb-amount');
const account = (page: Page) => page.getByTestId('disb-account');
const holder = (page: Page) => page.getByTestId('disb-holder');
const save = (page: Page) => page.getByTestId('disb-save');
const puts = (api: MockApi) => api.callsTo('PUT', DISBURSEMENT);
/** Талбарын Form.Item: алдаа ЯГ энэ талбарын доор гарч байгааг шалгахад. */
const itemOf = (page: Page, input: ReturnType<typeof amount>) => page.locator('.ant-form-item').filter({ has: input });
const validationReply = (path: string, message: string): MockReply => ({ status: 400, json: { code: 'VALIDATION_FAILED', message: 'Оруулсан өгөгдөл буруу', details: [{ path, message }] } });

test.describe('Олголтын маягт: серверийн алдаа талбар дээр (F5-4)', () => {
  test('a server zod error is shown in Mongolian under its own field, never as raw English with a camelCase name', async ({ page }) => {
    await setup(page, validationReply('accountNo', 'String must contain at least 4 character(s)'));
    await page.goto(URL);
    await account(page).fill('12345678'); // клиентийн дүрмийг давна, сервер илүү хатуу гэж үзнэ
    await save(page).click();
    await expect(itemOf(page, account(page)).getByText(ACCOUNT_SERVER_MIN)).toBeVisible();
    await expect(page.getByTestId('disb-save-error')).toHaveText(FORM_INVALID);
    await expect(page.getByText(SERVER_ENGLISH)).toHaveCount(0);
    await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
  });

  test('the summary sits inside the form card next to the save button, not at the bottom of the page', async ({ page }) => {
    await setup(page, validationReply('holderName', 'Required'));
    await page.goto(URL);
    await save(page).click();
    const card = page.locator('.ant-card').filter({ has: save(page) });
    await expect(card.getByTestId('disb-save-error')).toBeVisible();
    await expect(itemOf(page, holder(page)).getByText('Эзэмшигчийн нэр заавал бөглөнө')).toBeVisible();
  });

  test('editing the field clears its server error and the stale summary', async ({ page }) => {
    await setup(page, validationReply('accountNo', 'String must contain at least 4 character(s)'));
    await page.goto(URL);
    await account(page).fill('12345678');
    await save(page).click();
    await expect(itemOf(page, account(page)).getByText(ACCOUNT_SERVER_MIN)).toBeVisible();
    await account(page).fill('1234567');
    await expect(itemOf(page, account(page)).getByText(ACCOUNT_SERVER_MIN)).toHaveCount(0);
    await expect(page.getByTestId('disb-save-error')).toHaveCount(0);
  });

  test('a BR-10 rejection (amount above the approved amount) lands under the amount field with the server text', async ({ page }) => {
    const text = 'Олгох дүн батлагдсан дүнгээс (4000000) хэтэрч болохгүй (BR-10)'; // сервер өөр батлагдсан дүнтэй байх (хуучирсан хуудас)
    await setup(page, { status: 400, json: { code: 'DISBURSE_EXCEEDS_APPROVED', message: text } });
    await page.goto(URL);
    await amount(page).fill('4000000');
    await save(page).click();
    await expect(itemOf(page, amount(page)).getByText(text)).toBeVisible();
  });

  test('a state conflict shows the Mongolian server text as the summary only', async ({ page }) => {
    await setup(page, { status: 409, json: { code: 'DISBURSEMENT_NOT_EDITABLE', message: 'Илгээсэн олголтын хүсэлтийг засах боломжгүй' } });
    await page.goto(URL);
    await save(page).click();
    await expect(page.getByTestId('disb-save-error')).toHaveText('Илгээсэн олголтын хүсэлтийг засах боломжгүй');
  });
});

test.describe('Олголтын маягт: данс ба нэр (F5-5)', () => {
  for (const [value, message] of [['123', ACCOUNT_LENGTH], ['abcdefg', ACCOUNT_DIGITS], ['5012 3456 78', ACCOUNT_DIGITS], ['50123456-78', ACCOUNT_DIGITS], ['1'.repeat(35), ACCOUNT_LENGTH]] as const) {
    test(`account "${value.slice(0, 12)}" is rejected under the field and nothing is sent`, async ({ page }) => {
      const { api } = await setup(page);
      await page.goto(URL);
      await account(page).fill(value);
      await expect(itemOf(page, account(page)).getByText(message)).toBeVisible(); // шууд, хадгалахаас өмнө
      await save(page).click();
      await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
      expect(puts(api)).toHaveLength(0);
    });
  }

  for (const value of ['😀', 'Номин 😀', '👨‍👩‍👧', '<script>alert(1)</script>', 'A & B']) {
    test(`holder name "${value}" is rejected under the field and nothing is sent`, async ({ page }) => {
      const { api } = await setup(page);
      await page.goto(URL);
      await holder(page).fill(value);
      await expect(itemOf(page, holder(page)).getByText(HOLDER_CHARS)).toBeVisible();
      await save(page).click();
      await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
      expect(puts(api)).toHaveLength(0);
    });
  }

  test('a digits-only account and an ordinary Cyrillic name are saved as typed', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await account(page).fill('5012349999');
    await holder(page).fill('Бат-Эрдэнэ Дорж');
    await save(page).click();
    await expect(page.getByText(SAVED_TOAST)).toBeVisible();
    expect(puts(api)).toHaveLength(1);
    expect(puts(api)[0]!.body).toMatchObject({ accountNo: '5012349999', holderName: 'Бат-Эрдэнэ Дорж' });
  });

  test('an empty account keeps the saved one: no error and no accountNo in the request', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await save(page).click();
    await expect(page.getByText(SAVED_TOAST)).toBeVisible();
    expect(puts(api)[0]!.body).not.toHaveProperty('accountNo');
  });
});

test.describe('Олголтын маягт: олгох дүн (F5-16)', () => {
  for (const [value, message] of [['-5', AMOUNT_POSITIVE], ['5сая', AMOUNT_NOT_NUMBER], ['5,5', AMOUNT_NOT_NUMBER], ['0.004', AMOUNT_POSITIVE], ['99999999', AMOUNT_MAX]] as const) {
    test(`amount "${value}" shows an error under the input, keeps the typed text and sends nothing`, async ({ page }) => {
      const { api } = await setup(page);
      await page.goto(URL);
      await amount(page).fill(value);
      await expect(itemOf(page, amount(page)).getByText(message)).toBeVisible(); // шууд, хадгалахаас өмнө
      await save(page).click();
      await expect(amount(page)).toHaveValue(value); // чимээгүй "5" болгож засаагүй
      await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
      expect(puts(api)).toHaveLength(0);
    });
  }

  test('an amount equal to the approved amount is accepted', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await amount(page).fill(String(APPROVED));
    await save(page).click();
    await expect(page.getByText(SAVED_TOAST)).toBeVisible();
    expect(puts(api)[0]!.body).toMatchObject({ disburseAmount: APPROVED });
  });

  test('a grouped amount "4,000,000" is read faithfully and sent as 4000000', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await amount(page).fill('4,000,000');
    await save(page).click();
    await expect(page.getByText(SAVED_TOAST)).toBeVisible();
    expect(puts(api)[0]!.body).toMatchObject({ disburseAmount: 4_000_000 });
    await expect(amount(page)).toHaveValue('4000000'); // хадгалсны дараа формд серверийн утга
  });
});
