import { expect, test, type Page } from '@playwright/test';
import { DisbursementView, type UserRole } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Wizard-ийн «Зээл олгох хүсэлт» алхам (`/los/loan-application/:id/disburse`, FR-12) — батлагч ба илгээгчийн харагдац. Gateway-г mock хийсэн.
// F5-10 батлагч дүн/огноо/банк/эзэмшигчийн төрлийг харахгүй · F5-11 татгалзах шалтгаан "заавал биш" гэж худал бичсэн · F5-8 илгээх баталгаажуулалт юу илгээхийг хэлдэггүй · F5-9 түүх.
const APP_ID = '00000000-0000-4000-8000-0000000000d6';
const URL = `/los/loan-application/${APP_ID}/disburse`;
const DISBURSEMENT = '/applications/:id/disbursement';

type Entry = DisbursementView['history'][number];
const entry = (action: string, note: string | null = null): Entry => ({ at: '2026-12-01T03:00:00Z', by: 'user-1', action, note });

function makeView(o: Partial<DisbursementView> = {}): DisbursementView {
  return DisbursementView.parse({
    id: 'dsb-1', applicationId: APP_ID, applicationStatus: 'DISBURSING', status: 'SUBMITTED', approvedAmount: 5_000_000, disburseAmount: 5_000_000, termMonths: 12, interestRate: 28,
    repaymentType: 'ANNUITY', firstPaymentDate: '2027-01-05', disburseDate: '2026-12-05', bankCode: 'KHAN', accountNoMasked: '****5678', holderName: 'Номин Дашдорж',
    accountOwnerType: 'SELF', nameCheck: null, reconciliation: null, coreLoanId: null, checks: [], canSubmit: false, history: [entry('SUBMITTED')], ...o,
  });
}

async function setup(page: Page, role: UserRole, view: DisbursementView) {
  const api = new MockApi(role);
  const state = { view };
  api.get(DISBURSEMENT, () => ({ json: state.view }));
  api.post(`${DISBURSEMENT}/submit`, () => {
    state.view = makeView({ ...state.view, status: 'SUBMITTED', canSubmit: false, history: [...state.view.history, entry('SUBMITTED')] });
    return { json: state.view };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, state };
}

const summary = (page: Page) => page.getByTestId('disb-summary');
const dialog = (page: Page) => page.getByRole('dialog');
const rejectCalls = (api: MockApi) => api.callsTo('POST', `${DISBURSEMENT}/reject`);

test.describe('Олголтын хүсэлт: батлагчийн харагдац (F5-10)', () => {
  // "5₮ эсвэл гуравдагч этгээдийн дансанд олгохыг батлагч харахгүй байж "Зөвшөөрч олгох" дарна" — дээд карт зөвхөн батлагдсан дүн + маскласан данс харуулдаг байсан.
  test('approver sees the disburse amount, date, bank and owner type, and is warned about a changed amount and a third-party account', async ({ page }) => {
    const { api, guard } = await setup(page, 'APPROVER', makeView({ disburseAmount: 5, accountOwnerType: 'THIRD_PARTY' }));
    await page.goto(URL);
    await expect(page.getByTestId('disb-status')).toHaveText('Илгээсэн');
    await expect(summary(page).getByTestId('disb-sum-amount')).toHaveText('5₮');
    await expect(summary(page).getByTestId('disb-sum-date')).toHaveText('2026-12-05');
    await expect(summary(page).getByTestId('disb-sum-bank')).toHaveText('KHAN');
    await expect(summary(page).getByTestId('disb-sum-account')).toContainText('****5678');
    await expect(summary(page).getByTestId('disb-sum-owner')).toHaveText('Гуравдагч этгээд');
    await expect(summary(page).getByTestId('disb-warn-amount')).toContainText('5,000,000₮');
    await expect(summary(page).getByTestId('disb-warn-third-party')).toBeVisible();
    expectClean(guard, api);
  });

  test('no warnings when the amount equals the approved one and the account is the borrower\'s own', async ({ page }) => {
    await setup(page, 'APPROVER', makeView());
    await page.goto(URL);
    await expect(summary(page).getByTestId('disb-sum-amount')).toHaveText('5,000,000₮');
    await expect(summary(page).getByTestId('disb-sum-owner')).toHaveText('Өөрийн');
    await expect(page.getByTestId('disb-warn-amount')).toHaveCount(0);
    await expect(page.getByTestId('disb-warn-third-party')).toHaveCount(0);
  });

  test('the approve confirmation restates what will be disbursed before the click that moves money', async ({ page }) => {
    await setup(page, 'APPROVER', makeView({ disburseAmount: 5, accountOwnerType: 'THIRD_PARTY' }));
    await page.goto(URL);
    await page.getByTestId('disb-approve').click();
    await expect(dialog(page).getByTestId('disb-sum-amount')).toHaveText('5₮');
    await expect(dialog(page).getByTestId('disb-sum-owner')).toHaveText('Гуравдагч этгээд');
    await expect(dialog(page).getByTestId('disb-sum-account')).toContainText('****5678');
    await expect(dialog(page).getByTestId('disb-warn-third-party')).toBeVisible();
  });
});

test.describe('Олголтын хүсэлт: татгалзах шалтгаан заавал (F5-11)', () => {
  // Placeholder "Шалтгаан (заавал биш)" гэсэн ч сервер 400 "Буцаахдаа тайлбар бичих шаардлагатай" буцаадаг, алдаа modal-ын ард гардаг байсан.
  test('the reason is marked required and the reject button stays disabled until a reason is typed', async ({ page }) => {
    const { api } = await setup(page, 'APPROVER', makeView());
    api.post(`${DISBURSEMENT}/reject`, ({ body }) => ({ json: makeView({ status: 'DRAFT', history: [entry('SUBMITTED'), entry('REJECTED', (body as { comment: string }).comment)] }) }));
    await page.goto(URL);
    await page.getByTestId('disb-reject').click();
    const reason = dialog(page).getByRole('textbox');
    const ok = dialog(page).getByRole('button', { name: 'Татгалзах' });
    await expect(reason).toHaveAttribute('placeholder', /заавал/);
    expect(await reason.getAttribute('placeholder')).not.toMatch(/заавал биш/);
    await expect(ok).toBeDisabled();
    await reason.fill('   '); // зөвхөн хоосон зай — сервер trim хийж татгалзана
    await expect(ok).toBeDisabled();
    expect(rejectCalls(api)).toHaveLength(0);
    await reason.fill('Данс гуравдагч этгээдийнх');
    await expect(ok).toBeEnabled();
    await ok.click();
    await expect(dialog(page)).toHaveCount(0);
    expect(rejectCalls(api)).toHaveLength(1);
    expect(rejectCalls(api)[0]!.body).toEqual({ comment: 'Данс гуравдагч этгээдийнх' });
  });

  test('a server error on reject is shown inside the open dialog, not behind it', async ({ page }) => {
    const { api } = await setup(page, 'APPROVER', makeView());
    api.post(`${DISBURSEMENT}/reject`, { status: 409, json: { code: 'DISBURSEMENT_NOT_PENDING', message: 'Буцаах олголтын хүсэлт алга' } });
    await page.goto(URL);
    await page.getByTestId('disb-reject').click();
    await dialog(page).getByRole('textbox').fill('Шалтгаан');
    await dialog(page).getByRole('button', { name: 'Татгалзах' }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('Буцаах олголтын хүсэлт алга');
    await expect(dialog(page)).toBeVisible();
  });
});

test.describe('Олголтын хүсэлт: илгээх баталгаажуулалт (F5-8)', () => {
  const draft = () => makeView({ status: 'DRAFT', canSubmit: true, disburseAmount: 4_000_000, history: [entry('DRAFT_UPDATED')] });

  test('the submit confirmation restates the amount, date, bank, masked account, holder and owner type', async ({ page }) => {
    const { api } = await setup(page, 'OFFICER', draft());
    await page.goto(URL);
    await page.getByTestId('disb-submit').click();
    await expect(dialog(page)).toContainText('Олголтын хүсэлтийг илгээх үү?');
    await expect(dialog(page).getByTestId('disb-sum-amount')).toHaveText('4,000,000₮');
    await expect(dialog(page).getByTestId('disb-sum-date')).toHaveText('2026-12-05');
    await expect(dialog(page).getByTestId('disb-sum-bank')).toHaveText('KHAN');
    await expect(dialog(page).getByTestId('disb-sum-account')).toContainText('****5678');
    await expect(dialog(page).getByTestId('disb-sum-account')).toContainText('Номин Дашдорж');
    await expect(dialog(page).getByTestId('disb-sum-owner')).toHaveText('Өөрийн');
    expect(api.callsTo('POST', `${DISBURSEMENT}/submit`)).toHaveLength(0); // баталгаажуулах хүртэл илгээгдэхгүй
  });

  test('after submitting, the officer is told the request waits for the approver', async ({ page }) => {
    const { api } = await setup(page, 'OFFICER', draft());
    await page.goto(URL);
    await expect(page.getByTestId('disb-waiting')).toHaveCount(0); // ноорог — хүлээгдэж буй зүйл алга
    await page.getByTestId('disb-submit').click();
    await dialog(page).getByRole('button', { name: 'Илгээх' }).click();
    await expect(page.getByTestId('disb-waiting')).toContainText('Батлагчийн шийдвэрийг хүлээж байна');
    expect(api.callsTo('POST', `${DISBURSEMENT}/submit`)).toHaveLength(1);
  });

  test('the approver, who is the one expected to act, does not get the waiting notice', async ({ page }) => {
    await setup(page, 'APPROVER', makeView());
    await page.goto(URL);
    await expect(page.getByTestId('disb-approve')).toBeVisible();
    await expect(page.getByTestId('disb-waiting')).toHaveCount(0);
  });
});

test.describe('Олголтын хүсэлт: түүх (F5-9)', () => {
  const noisy = [...Array.from({ length: 5 }, () => entry('DRAFT_UPDATED')), entry('SUBMITTED'), entry('REJECTED', 'Данс буруу'), ...Array.from({ length: 3 }, () => entry('DRAFT_UPDATED'))];

  test('history uses Mongolian labels and folds repeated draft saves into one row', async ({ page }) => {
    const { api, guard } = await setup(page, 'OFFICER', makeView({ status: 'DRAFT', history: noisy }));
    await page.goto(URL);
    const rows = page.getByTestId('disb-history-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Ноорог хадгалсан ×5');
    await expect(rows.nth(1)).toContainText('Илгээсэн');
    await expect(rows.nth(2)).toContainText('Татгалзсан — Данс буруу');
    await expect(rows.nth(3)).toContainText('Ноорог хадгалсан ×3');
    await expect(page.getByTestId('disb-history')).not.toContainText('DRAFT_UPDATED');
    await expect(page.getByTestId('disb-history')).not.toContainText('REJECTED');
    expectClean(guard, api);
  });

  test('a rejected draft shows the rejection reason in a banner above the details', async ({ page }) => {
    await setup(page, 'OFFICER', makeView({ status: 'DRAFT', history: noisy }));
    await page.goto(URL);
    const banner = page.getByTestId('disb-rejected-banner');
    await expect(banner).toContainText('Данс буруу');
    const [bannerBox, summaryBox] = [await banner.boundingBox(), await summary(page).boundingBox()];
    expect(bannerBox!.y).toBeLessThan(summaryBox!.y);
  });

  test('no rejection banner for a draft that was never rejected', async ({ page }) => {
    await setup(page, 'OFFICER', makeView({ status: 'DRAFT', history: [entry('DRAFT_UPDATED')] }));
    await page.goto(URL);
    await expect(page.getByTestId('disb-history-row')).toHaveCount(1);
    await expect(page.getByTestId('disb-rejected-banner')).toHaveCount(0);
  });
});
