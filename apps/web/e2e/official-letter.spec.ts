import { expect, test, type Page } from '@playwright/test';
import { OfficialLetterView, type ContractView } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi, type MockReply } from './mock-api';

// Wizard-ийн «Албан бичиг» алхам (`/los/loan-application/:id/official_documents`, FR-11.3). Gateway-г mock хийсэн.
// F4-10: «Албан бичиг үүсгэх» товчийг давхар дарахад хоёр бичиг (№2, №3) үүсч, дарсан ч юу болсон нь харагддаггүй байсан.
const APP_ID = '00000000-0000-4000-8000-0000000000d4';
const URL = `/los/loan-application/${APP_ID}/official_documents`;
const CONTRACT = '/applications/:id/contract';
const CREATE = '/applications/:id/contract/official-letters';
const CREATE_LABEL = 'Албан бичиг үүсгэх';
const EMPTY_TEXT = 'Албан бичиг үүсээгүй байна.';
const SLOW_MS = 400;
const NOW = '2026-11-21T03:00:00.000Z';

const contract = (): ContractView => ({
  id: 'c-1', applicationId: APP_ID, contractNo: 'LC-2026-0001', templateVersion: 1, generatedFileId: 'file-gen-1', signedFileId: null, signedAt: null, signChannel: 'PAPER', signingStatus: null,
}) as ContractView;

const letter = (n: number): OfficialLetterView =>
  OfficialLetterView.parse({ id: `l-${n}`, applicationId: APP_ID, templateId: 't-1', generatedFileId: `file-l-${n}`, printedAt: null, createdAt: NOW });

/** Жинхэнэ сервер шиг: POST бүр шинэ бичиг нэмж, GET дараагийн жагсаалтад харуулна. `create`-ээр сервер талын алдааг дуурайна. */
async function setup(page: Page, opts: { existing?: number; create?: () => MockReply | undefined } = {}) {
  const api = new MockApi('OFFICER');
  const letters: OfficialLetterView[] = Array.from({ length: opts.existing ?? 0 }, (_v, i) => letter(i + 1));
  api.get(CONTRACT, () => ({ json: { contract: contract(), letters } }));
  api.post(CREATE, () => {
    const failure = opts.create?.();
    if (failure) return failure;
    const created = letter(letters.length + 1);
    letters.push(created);
    return { status: 201, json: created, delayMs: SLOW_MS };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, letters };
}

const createButton = (page: Page) => page.getByTestId('letter-create');
const creates = (api: MockApi) => api.callsTo('POST', CREATE);
const rows = (page: Page) => page.locator('.ant-list-item');
const openStep = async (page: Page) => {
  await page.goto(URL);
  await expect(createButton(page)).toBeVisible();
  await expect(createButton(page)).toContainText(CREATE_LABEL);
};

test.describe('Албан бичиг: давхар дарахаас хамгаалах (F4-10)', () => {
  test('a real double-click creates exactly one letter', async ({ page }) => {
    const { api, guard } = await setup(page);
    await openStep(page);
    await createButton(page).dblclick();

    await expect(rows(page)).toHaveCount(1);
    expect(creates(api)).toHaveLength(1);
    await expect(page.getByText(EMPTY_TEXT)).toHaveCount(0);
    expectClean(guard, api);
  });

  test('two clicks in the same task, before React can re-render, still send one request', async ({ page }) => {
    const { api } = await setup(page);
    await openStep(page);
    await createButton(page).evaluate((el: HTMLElement) => { el.click(); el.click(); });

    await expect(rows(page)).toHaveCount(1);
    expect(creates(api)).toHaveLength(1);
  });

  test('the button is disabled while the request is pending and enabled again after', async ({ page }) => {
    const { api } = await setup(page);
    await openStep(page);
    await createButton(page).click();

    await expect(createButton(page)).toBeDisabled();
    await expect(rows(page)).toHaveCount(1);
    await expect(createButton(page)).toBeEnabled();
    expect(creates(api)).toHaveLength(1);
  });
});

test.describe('Албан бичиг: үр дүн харагдах (F4-10)', () => {
  test('the success message carries the new letter number and the new row is marked', async ({ page }) => {
    const { api } = await setup(page, { existing: 2 });
    await openStep(page);
    await expect(rows(page)).toHaveCount(2);
    await createButton(page).click();

    await expect(page.locator('.ant-message-notice').filter({ hasText: 'Албан бичиг №3 үүслээ' })).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(2)).toContainText('№3');
    await expect(rows(page).nth(2).locator('.ant-tag', { hasText: 'Шинэ' })).toBeVisible();
    await expect(rows(page).nth(1).locator('.ant-tag', { hasText: 'Шинэ' })).toHaveCount(0);
    expect(creates(api)).toHaveLength(1);
  });

  test('a failed create shows no success message, releases the button, and a retry sends a second request', async ({ page }) => {
    let failNext = true;
    const { api } = await setup(page, { create: () => { if (!failNext) return undefined; failNext = false; return { status: 500, json: { code: 'INTERNAL_ERROR', message: 'Серверийн алдаа' } }; } });
    await openStep(page);
    await createButton(page).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.locator('.ant-message-notice').filter({ hasText: 'үүслээ' })).toHaveCount(0);
    await expect(rows(page)).toHaveCount(0);
    await expect(createButton(page)).toBeEnabled();
    expect(creates(api)).toHaveLength(1);

    await createButton(page).click();
    await expect(rows(page)).toHaveCount(1);
    expect(creates(api)).toHaveLength(2);
  });
});
