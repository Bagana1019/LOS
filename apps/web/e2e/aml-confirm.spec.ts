import { expect, test, type Page } from '@playwright/test';
import { AmlHitReviewRequest, AmlScreeningDetail, type AmlHit } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi, type MockHandler } from './mock-api';

// Compliance · AML шалгалтын дэлгэрэнгүй (`/los/compliance/aml/:screeningId`). Gateway-г mock хийсэн.
// F7-2: "Шийдвэр хадгалах" нэг товшилтоор, баталгаажуулалтгүйгээр хадгалагддаг байсан. Шийдвэр буцаагдахгүй (дахин шийдвэрлэх нь 409) тул баталгаажуулах цонх заавал.
const SCREENING_ID = 'scr-aml-1';
const URL = `/los/compliance/aml/${SCREENING_ID}`;
const SCREENING = '/kyc/aml/screenings/:id';
const REVIEW = '/kyc/aml/hits/:id/review';
const ENTRY_NAME = 'GANBOLD Bat-Erdene';
const COMMENT = 'Төрсөн он зөрүүтэй, өөр хүн';

const makeHit = (over: Partial<AmlHit> = {}): AmlHit => ({
  id: 'hit-1', list: 'UN_SC', matchType: 'NAME_FUZZY', score: 1, severity: 'BLOCKING', status: 'OPEN', entryRef: 'FIXTURE-UN-001', entryName: ENTRY_NAME,
  matchedValue: ENTRY_NAME, listVersion: 'un-v1', reviewedBy: null, reviewedAt: null, reviewComment: null,
  details: { programme: 'DPRK', listedOn: '2020-01-01', partyType: 'INDIVIDUAL', matchedName: ENTRY_NAME, dateOfBirth: 'MATCH', nationalities: ['KP'] },
  ...over,
});

const makeDetail = (hit: AmlHit = makeHit()): AmlScreeningDetail =>
  AmlScreeningDetail.parse({
    id: SCREENING_ID, orgId: 'org-1', customerId: 'cust-1', applicationId: 'app-1', trigger: 'APPLICATION', status: 'REVIEW_REQUIRED', blocking: true,
    riskScore: 60, riskLevel: 'HIGH', riskFactors: [], subjectName: 'Ганболд Бат-Эрдэнэ', registerNoMasked: '*******321', hits: [hit],
    listVersions: { UN_SC: 'un-v1', FATF: 'f-1', INTERNAL_BLACKLIST: 'live' }, screenedAt: '2026-10-28T09:00:00.000Z', screenedBy: 'officer-1',
    subject: { subjectType: 'INDIVIDUAL', lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', aliases: [], birthYear: 1980, countries: ['MN'], isPep: false, isRelatedParty: false },
  });

async function setup(page: Page, review: MockHandler = () => ({ json: makeDetail(makeHit({ status: 'FALSE_POSITIVE' })) })) {
  const api = new MockApi('COMPLIANCE');
  api.get(SCREENING, () => ({ json: makeDetail() }));
  api.post(REVIEW, review);
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

const form = (page: Page) => page.getByTestId('aml-review-hit-1');
const posts = (api: MockApi) => api.callsTo('POST', REVIEW);
const dialog = (page: Page) => page.getByRole('dialog');

/** Шийдвэр сонгож, тайлбар бичээд "Шийдвэр хадгалах"-ыг дарна. */
async function fillAndSave(page: Page, decisionLabel: string, comment = COMMENT) {
  await form(page).getByText(decisionLabel, { exact: true }).click();
  await form(page).getByRole('textbox').fill(comment);
  await form(page).getByRole('button', { name: 'Шийдвэр хадгалах' }).click();
}

test.describe('AML тохирлын шийдвэр: баталгаажуулалт (F7-2)', () => {
  test('saving a decision asks for confirmation first: final, decision label and hit name shown, nothing sent yet', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await fillAndSave(page, 'Худал тохирол');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('эцсийн');
    await expect(dialog(page)).toContainText('Худал тохирол');
    await expect(dialog(page)).toContainText(ENTRY_NAME);
    expect(posts(api), 'no request before the user confirms').toHaveLength(0);
  });

  test('confirming sends exactly one request with the chosen decision and the trimmed comment', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    await fillAndSave(page, 'Жинхэнэ тохирол', `  ${COMMENT}  `);
    await dialog(page).getByRole('button', { name: 'Тийм, шийдвэрийг хадгалах' }).click();
    await expect(page.getByText('Шийдвэр хадгалагдлаа')).toBeVisible();
    expect(posts(api)).toHaveLength(1);
    expect(AmlHitReviewRequest.parse(posts(api)[0]?.body)).toEqual({ decision: 'CONFIRMED', comment: COMMENT });
    expectClean(guard, api);
  });

  test('cancelling the confirmation sends nothing and keeps what the user typed', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await fillAndSave(page, 'Худал тохирол');
    await dialog(page).getByRole('button', { name: 'Болих' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(form(page).getByRole('textbox')).toHaveValue(COMMENT);
    expect(posts(api)).toHaveLength(0);
  });

  test('a comment under 5 characters is still rejected in the form: no confirmation, no request', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await fillAndSave(page, 'Худал тохирол', 'abcd');
    await expect(page.getByText('Тайлбар хамгийн багадаа 5 тэмдэгт')).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts(api)).toHaveLength(0);
  });

  test('a second attempt (409 already reviewed) is explained in Mongolian, not as a raw server message', async ({ page }) => {
    const { api } = await setup(page, () => ({ status: 409, json: { code: 'CONFLICT', message: 'Hit has already been reviewed' } }));
    await page.goto(URL);
    await fillAndSave(page, 'Худал тохирол');
    await dialog(page).getByRole('button', { name: 'Тийм, шийдвэрийг хадгалах' }).click();
    await expect(page.getByText('Энэ тохирлыг өөр хэрэглэгч аль хэдийн шийдвэрлэсэн байна')).toBeVisible();
    await expect(page.getByText('Hit has already been reviewed')).toHaveCount(0);
    expect(posts(api)).toHaveLength(1);
  });
});
