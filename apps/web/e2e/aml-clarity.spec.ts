import { expect, test, type Page } from '@playwright/test';
import { AmlHitQueuePage, AmlScreeningDetail, type AmlHit } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi, type MockRequest } from './mock-api';

// Compliance · AML: дараалал (tab, нэр томьёо) ба дэлгэрэнгүйн мэдэгдэл. Gateway-г mock хийсэн.
// F7-3 "Тохирол баталгаажсан" + "шийдвэр хүлээж байна" зөрчилдөж байсан · F7-6 шийдвэрлэсэн hit дарааллаас алга болдог байсан · F7-7 «Хаах» түвшин "close" гэж уншигддаг байсан.
const QUEUE_URL = '/los/compliance/aml';
const SCREENING_ID = 'scr-aml-9';
const HITS = '/kyc/aml/hits';
const SCREENING = '/kyc/aml/screenings/:id';
const REVIEW = '/kyc/aml/hits/:id/review';
const COMMENT = 'Регистр, төрсөн огноо бүгд таарсан';

const makeHit = (over: Partial<AmlHit> = {}): AmlHit => ({
  id: 'hit-9', list: 'UN_SC', matchType: 'NAME_FUZZY', score: 1, severity: 'BLOCKING', status: 'OPEN', entryRef: 'FIXTURE-UN-009', entryName: 'GANBOLD Bat-Erdene',
  matchedValue: 'GANBOLD Bat-Erdene', listVersion: 'un-v1', reviewedBy: null, reviewedAt: null, reviewComment: null,
  details: { programme: 'DPRK', matchedName: 'GANBOLD Bat-Erdene', dateOfBirth: 'MATCH', nationalities: ['KP'] },
  ...over,
});
const RESOLVED = { status: 'CONFIRMED', reviewedBy: 'compliance-2', reviewedAt: '2026-10-28T10:00:00.000Z', reviewComment: COMMENT } as const;

const queueRow = (hit: AmlHit) => ({
  hit,
  screening: { id: SCREENING_ID, customerId: 'cust-9', applicationId: 'app-9', status: hit.status === 'OPEN' ? 'REVIEW_REQUIRED' : 'CONFIRMED_MATCH', subjectName: 'Ганболд Бат-Эрдэнэ', registerNoMasked: '*******321', screenedAt: '2026-10-28T09:00:00.000Z' },
});

const makeDetail = (hit: AmlHit): AmlScreeningDetail =>
  AmlScreeningDetail.parse({
    id: SCREENING_ID, orgId: 'org-1', customerId: 'cust-9', applicationId: 'app-9', trigger: 'APPLICATION',
    status: hit.status === 'OPEN' ? 'REVIEW_REQUIRED' : 'CONFIRMED_MATCH', blocking: true,
    riskScore: 60, riskLevel: 'HIGH', riskFactors: [], subjectName: 'Ганболд Бат-Эрдэнэ', registerNoMasked: '*******321', hits: [hit],
    listVersions: { UN_SC: 'un-v1', FATF: 'f-1', INTERNAL_BLACKLIST: 'live' }, screenedAt: '2026-10-28T09:00:00.000Z', screenedBy: 'officer-1',
    subject: { subjectType: 'INDIVIDUAL', lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', aliases: [], birthYear: 1980, countries: ['MN'], isPep: false, isRelatedParty: false },
  });

/** `GET /kyc/aml/hits`-ийг жинхэнэ шиг `status` query-гээр шүүнэ: OPEN → нээлттэй, CONFIRMED → шийдвэрлэсэн, status байхгүй → бүгд. */
function queueHandler({ search }: MockRequest) {
  const open = queueRow(makeHit());
  const done = queueRow(makeHit({ id: 'hit-8', entryName: 'Өөр бүртгэл', ...RESOLVED }));
  const status = search.get('status');
  const items = status === 'OPEN' ? [open] : status === 'CONFIRMED' ? [done] : status === null ? [open, done] : [];
  return { json: AmlHitQueuePage.parse({ total: status === 'OPEN' ? 45 : items.length, items }) };
}

async function setupQueue(page: Page) {
  const api = new MockApi('COMPLIANCE');
  api.get(HITS, queueHandler);
  await api.install(page);
  return { api, guard: guardConsole(page) };
}

const statuses = (api: MockApi) => api.callsTo('GET', HITS).map((c) => c.search.get('status'));
const lastCall = (api: MockApi) => api.callsTo('GET', HITS).at(-1);

test.describe('AML дараалал: tab, нэр томьёо (F7-6, F7-7)', () => {
  test('default tab is pending (status=OPEN); the blocking level reads «Блоклох», never «Хаах», and a tooltip explains it', async ({ page }) => {
    const { api, guard } = await setupQueue(page);
    await page.goto(QUEUE_URL);
    await expect(page.getByRole('tab', { name: 'Хүлээгдэж буй' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Ганболд Бат-Эрдэнэ')).toBeVisible();
    expect(statuses(api)).toEqual(['OPEN']);
    await expect(page.getByText('Хаах', { exact: true })).toHaveCount(0);
    const tag = page.getByText('Блоклох', { exact: true }).first();
    await expect(tag).toBeVisible();
    await tag.hover();
    await expect(page.getByRole('tooltip')).toContainText('илгээгдэхгүй');
    expectClean(guard, api);
  });

  test('the "true match" tab lists resolved hits (status=CONFIRMED) with status, decision date and a "Харах" link', async ({ page }) => {
    const { api, guard } = await setupQueue(page);
    await page.goto(QUEUE_URL);
    await page.getByRole('tab', { name: 'Жинхэнэ тохирол' }).click();
    await expect(page.getByText('Өөр бүртгэл')).toBeVisible();
    expect(lastCall(api)?.search.get('status')).toBe('CONFIRMED');
    const row = page.getByRole('row').filter({ hasText: 'Өөр бүртгэл' });
    await expect(row).toContainText('Жинхэнэ тохирол');
    await expect(row).toContainText('2026-10-28');
    await expect(row.getByRole('link', { name: 'Харах' })).toHaveAttribute('href', `${QUEUE_URL}/${SCREENING_ID}`);
    await expect(page.getByRole('columnheader', { name: 'Шийдвэрлэсэн огноо' })).toBeVisible();
    expectClean(guard, api);
  });

  test('the "all" tab sends no status filter and shows pending and resolved hits together', async ({ page }) => {
    const { api } = await setupQueue(page);
    await page.goto(QUEUE_URL);
    await page.getByRole('tab', { name: 'Бүгд' }).click();
    await expect(page.getByText('Өөр бүртгэл')).toBeVisible();
    await expect(page.getByText('GANBOLD Bat-Erdene')).toBeVisible();
    expect(lastCall(api)?.search.has('status')).toBe(false);
    expect(statuses(api)).toEqual(['OPEN', null]);
  });

  test('switching tab goes back to the first page (offset 0) instead of keeping page 2 of another list', async ({ page }) => {
    const { api } = await setupQueue(page);
    await page.goto(QUEUE_URL);
    await page.getByRole('listitem', { name: '2', exact: true }).click();
    await expect.poll(() => lastCall(api)?.search.get('offset')).toBe('20');
    await page.getByRole('tab', { name: 'Худал тохирол' }).click();
    await expect.poll(() => lastCall(api)?.search.get('status')).toBe('FALSE_POSITIVE');
    expect(lastCall(api)?.search.get('offset')).toBe('0');
    await expect(page.getByText('Энэ төлөвт тохирол алга')).toBeVisible();
  });
});

test.describe('AML дэлгэрэнгүй: хүсэлт илгээхийг хориглосон мэдэгдэл (F7-3, F7-7)', () => {
  /** Төлөвтэй mock: шийдвэр хадгалмагц дэлгэрэнгүй CONFIRMED_MATCH болно (жинхэнэ kyc шиг). */
  async function setupDetail(page: Page) {
    let current = makeHit();
    const api = new MockApi('COMPLIANCE');
    api.get(SCREENING, () => ({ json: makeDetail(current) }));
    api.post(REVIEW, () => { current = makeHit(RESOLVED); return { json: makeDetail(current) }; });
    await api.install(page);
    return { api, guard: guardConsole(page) };
  }

  test('after confirming a true match the page says the application will NOT be submitted - not "awaiting decision"', async ({ page }) => {
    const { api, guard } = await setupDetail(page);
    await page.goto(`${QUEUE_URL}/${SCREENING_ID}`);
    await expect(page.getByText('Хүсэлт илгээх боломжгүй (шийдвэр хүлээж байна)')).toBeVisible();

    const form = page.getByTestId('aml-review-hit-9');
    await form.getByText('Жинхэнэ тохирол', { exact: true }).click();
    await form.getByRole('textbox').fill(COMMENT);
    await form.getByRole('button', { name: 'Шийдвэр хадгалах' }).click();

    // F7-7: баталгаажуулах цонх ижил нэр томьёотой — "хаалт/хаагдана" гэхгүй.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('илгээгдэхгүй хэвээр үлдэнэ');
    await expect(dialog).not.toContainText(/хаалт|хаагд|Хаах/);
    await dialog.getByRole('button', { name: 'Тийм, шийдвэрийг хадгалах' }).click();

    const alert = page.getByRole('alert').filter({ hasText: 'Тохирол баталгаажсан —' });
    await expect(alert).toContainText('энэ харилцагчийн зээлийн хүсэлт илгээгдэхгүй');
    await expect(page.getByText('шийдвэр хүлээж байна')).toHaveCount(0);
    expect(api.callsTo('POST', REVIEW)).toHaveLength(1);
    expectClean(guard, api);
  });
});
