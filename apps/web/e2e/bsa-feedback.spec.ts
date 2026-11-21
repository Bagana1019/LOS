import { expect, test, type Page } from '@playwright/test';
import { BsaLosOverview } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';
import { ANALYSIS_URL, APP_ID, FAILED_JOB, installBsa, newBsaWorld, OVERVIEW_URL, SC, type BsaWorld, type JobFixture } from './bsa-mock';

// BSA дэлгэцийн үр дүн, алдааны мэдээлэл (naive-user тест F6-2, F6-3, F6-4, F6-6, F6-7, F6-12). Gateway-г mock хийсэн.

async function setup(page: Page, o: Partial<BsaWorld> = {}) {
  const api = new MockApi('OFFICER');
  const world = newBsaWorld(o);
  installBsa(api, world);
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, world };
}

const file = (name: string, mimeType = 'application/pdf', body = '%PDF-1.4 synthetic statement') => ({ name, mimeType, buffer: Buffer.from(body) });
const toast = (page: Page, text: string | RegExp) => page.locator('.ant-message-notice-content', { hasText: text });
const alertWith = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text });
const job = (id: string, status: JobFixture['status'], fileName = `${id}.pdf`): JobFixture => ({ id, analysisId: 'an-1', fileName, status, bankCode: 'KHAN', errors: [] });
const goSuspicions = async (page: Page) => { await page.goto(ANALYSIS_URL); await page.getByRole('tab', { name: 'Сэжигтэй дохио' }).click(); };
const pickRow = (page: Page, flagName: string) => page.getByRole('row', { name: flagName }).first().getByRole('checkbox').check();

/** Scoring-ийн импортын алдааны бие (BsaExceptionFilter): `{ statusCode, code, message, details: { outcomes } }`. */
const importError = (status: number, code: string, outcomes: unknown[] = []) => ({ status, json: { statusCode: status, code, message: 'server', details: { outcomes, accepted: 0, duplicates: 0, rejected: outcomes.length } } });
const rejection = (index: number, code: string) => ({ index, status: 'REJECTED', code, message: 'server' });

test.describe('F6-2: «Төлбөр шинэчлэх» — үр дүнг хэлнэ', () => {
  test('with no registered payment the button is disabled and the reason is written next to it', async ({ page }) => {
    const { api, guard } = await setup(page, { proposedMonthlyPayment: null });
    await page.goto(OVERVIEW_URL);
    await expect(page.getByRole('button', { name: 'Төлбөр шинэчлэх' })).toBeDisabled();
    await expect(page.getByText(/бүртгэгдээгүй тул шинэчлэх зүйл алга/)).toBeVisible();
    expect(api.callsTo('POST', '/applications/:id/bsa/sync-payment')).toHaveLength(0);
    await expectClean(guard, api);
  });

  test('clicking it with a registered payment answers with a toast, also when nothing changed', async ({ page }) => {
    const { api } = await setup(page);
    api.post('/applications/:id/bsa/sync-payment', { json: { updated: 0 } });
    await page.goto(OVERVIEW_URL);
    await page.getByRole('button', { name: 'Төлбөр шинэчлэх' }).click();
    await expect(toast(page, /Шинжилгээнд өөрчлөх зүйл алга/)).toBeVisible();
  });

  test('says how many analyses were refreshed when the payment changed', async ({ page }) => {
    const { api } = await setup(page);
    api.post('/applications/:id/bsa/sync-payment', { json: { updated: 1 } });
    await page.goto(OVERVIEW_URL);
    await page.getByRole('button', { name: 'Төлбөр шинэчлэх' }).click();
    await expect(toast(page, /1 шинжилгээний ӨОХ дахин тооцогдлоо/)).toBeVisible();
  });
});

test.describe('F6-3: «Шинжилгээ үүсгэх» — давхар дарахад нэг л шинжилгээ', () => {
  test('two clicks in the same tick send exactly one create request', async ({ page }) => {
    const { api } = await setup(page);
    const noAnalysis = BsaLosOverview.parse({
      applicationId: APP_ID, summary: null, proposedMonthlyPayment: 450_000, available: true, editable: true,
      borrowers: [{ customerId: 'c1', role: 'PRIMARY', displayName: 'Номин Дашдорж', analysisId: null, status: null, version: null, dtiPercent: null, pendingSuspiciousCount: null }],
    });
    api.get('/applications/:id/bsa', { json: noAnalysis });
    api.post('/applications/:id/bsa/analyses', { status: 201, json: {}, delayMs: 400 });
    await page.goto(OVERVIEW_URL);
    // Нэг task дотор 2 click: TanStack-ийн isPending төлөв асинхрон тул товчны `loading` хоёр дахь click-ийг барьж чадахгүй.
    await page.getByRole('button', { name: 'Шинжилгээ үүсгэх' }).evaluate((el: HTMLElement) => { el.click(); el.click(); });
    await expect.poll(() => api.callsTo('POST', '/applications/:id/bsa/analyses').length).toBeGreaterThan(0);
    await page.waitForTimeout(700);
    expect(api.callsTo('POST', '/applications/:id/bsa/analyses')).toHaveLength(1);
  });
});

test.describe('F6-4: хуулга оруулах алдаа — Монгол, ойлгомжтой', () => {
  test('an unsupported file (415) shows the supported formats, not "Unsupported Media Type"', async ({ page }) => {
    const { api } = await setup(page);
    api.post(`${SC}/imports`, importError(415, 'FILE_UNSUPPORTED', [rejection(0, 'FILE_UNSUPPORTED')]));
    await page.goto(ANALYSIS_URL);
    await page.setInputFiles('input[type=file]', [file('virus.exe', 'application/octet-stream', 'MZ')]);
    const a = alertWith(page, /Энэ төрлийн файл дэмжигдэхгүй/);
    await expect(a).toBeVisible();
    await expect(a).toContainText('PDF');
    await expect(page.getByText('Unsupported Media Type')).toHaveCount(0);
  });

  test('an empty file (400) says the file is empty', async ({ page }) => {
    const { api } = await setup(page);
    api.post(`${SC}/imports`, importError(400, 'FILE_EMPTY', [rejection(0, 'FILE_EMPTY')]));
    await page.goto(ANALYSIS_URL);
    await page.setInputFiles('input[type=file]', [file('empty.pdf', 'application/pdf', '')]);
    await expect(alertWith(page, /Файл хоосон байна/)).toBeVisible();
    await expect(page.getByText('Bad Request')).toHaveCount(0);
  });

  test('several rejected files get one line each; the file picker is limited to supported types and the hint states the limits', async ({ page }) => {
    const { api } = await setup(page);
    api.post(`${SC}/imports`, importError(415, 'FILE_UNSUPPORTED', [rejection(0, 'FILE_UNSUPPORTED'), rejection(1, 'FILE_EMPTY')]));
    await page.goto(ANALYSIS_URL);
    await expect(page.locator('input[type=file]')).toHaveAttribute('accept', /\.pdf/);
    await expect(page.locator('input[type=file]')).not.toHaveAttribute('accept', /\.xlsx/);
    await expect(page.getByText(/20 МБ/)).toBeVisible();
    await page.setInputFiles('input[type=file]', [file('a.exe', 'application/octet-stream', 'MZ'), file('b.pdf', 'application/pdf', '')]);
    const a = alertWith(page, /Ямар ч файл хүлээн авагдсангүй/);
    await expect(a).toContainText('a.exe');
    await expect(a).toContainText('b.pdf');
  });
});

test.describe('F6-6: импортын ажлууд — төлөв Монголоор', () => {
  test('every job status is a Mongolian tag, the raw enum never shows', async ({ page }) => {
    await setup(page, { jobs: [job('j1', 'PENDING'), job('j2', 'PROCESSING'), job('j3', 'COMPLETED'), { ...FAILED_JOB, id: 'j4', fileName: 'bad.pdf' }] });
    await page.goto(ANALYSIS_URL);
    const table = page.getByRole('table').filter({ hasText: 'bad.pdf' });
    for (const label of ['Хүлээгдэж буй', 'Боловсруулж буй', 'Дууссан', 'Алдаатай']) await expect(table.getByText(label, { exact: true })).toBeVisible();
    for (const raw of ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']) await expect(page.getByText(raw, { exact: true })).toHaveCount(0);
  });
});

test.describe('F6-7: хуулга оруулсны үр дүн', () => {
  test('a duplicate upload (server 200 {duplicates:1}) is announced, naming the file and the next step', async ({ page }) => {
    const { api } = await setup(page);
    api.post(`${SC}/imports`, { status: 200, json: { outcomes: [{ index: 0, status: 'DUPLICATE', existingJobId: 'job-old' }], accepted: 0, duplicates: 1, rejected: 0 } });
    await page.goto(ANALYSIS_URL);
    await page.setInputFiles('input[type=file]', [file('statement-sep.pdf')]);
    const a = alertWith(page, /1 файл өмнө оруулсан тул алгасав/);
    await expect(a).toBeVisible();
    await expect(a).toContainText('statement-sep.pdf');
    await expect(a).toContainText('өөр файл');
  });

  test('a mixed upload reports accepted, duplicate and rejected counts', async ({ page }) => {
    const { api } = await setup(page);
    api.post(`${SC}/imports`, {
      status: 202,
      json: { outcomes: [{ index: 0, status: 'ACCEPTED', jobId: 'j1', format: 'PDF' }, { index: 1, status: 'DUPLICATE', existingJobId: 'old' }, rejection(2, 'FILE_EMPTY')], accepted: 1, duplicates: 1, rejected: 1 },
    });
    await page.goto(ANALYSIS_URL);
    await page.setInputFiles('input[type=file]', [file('ok.pdf'), file('dup.pdf'), file('empty.pdf')]);
    const a = alertWith(page, /1 файл хүлээн авлаа/);
    await expect(a).toContainText('1 файл өмнө оруулсан');
    await expect(a).toContainText('1 файл татгалзлаа');
    await expect(a).toContainText('empty.pdf');
  });

  test('a plain accepted upload confirms it', async ({ page }) => {
    await setup(page);
    await page.goto(ANALYSIS_URL);
    await page.setInputFiles('input[type=file]', [file('a.pdf')]);
    await expect(alertWith(page, /1 файл хүлээн авлаа/)).toBeVisible();
  });
});

test.describe('F6-12: дахин тооцоолох / зөвшөөрөх / хасах / татах — үр дүнг хэлнэ', () => {
  test('recalculate confirms with a toast', async ({ page }) => {
    await setup(page);
    await page.goto(ANALYSIS_URL);
    await page.getByRole('button', { name: 'Дахин тооцоолох' }).click();
    await expect(toast(page, /Дахин тооцоолж дууслаа/)).toBeVisible();
  });

  test('approving says what happened and why the rows left the pending list', async ({ page }) => {
    const { world } = await setup(page);
    await goSuspicions(page);
    await pickRow(page, 'Өөрийн дансны шилжүүлэг');
    await page.getByRole('button', { name: 'Зөвшөөрөх', exact: true }).click();
    await expect.poll(() => world.resolves).toHaveLength(1);
    const t = toast(page, /1 дохиог зөвшөөрлөө/);
    await expect(t).toBeVisible();
    await expect(t).toContainText('шүүлтүүр');
  });

  test('excluding asks first; cancel sends nothing, confirm sends once and confirms with a toast', async ({ page }) => {
    const { world } = await setup(page);
    await goSuspicions(page);
    await pickRow(page, 'Өөрийн дансны шилжүүлэг');
    const exclude = page.getByRole('button', { name: 'Тооцооноос хасах', exact: true });
    await exclude.click();
    const pop = page.locator('.ant-popconfirm');
    await expect(pop).toContainText('1 дохиог тооцооноос хасах уу?');
    await pop.getByRole('button', { name: 'Болих', exact: true }).click();
    expect(world.resolves).toHaveLength(0);
    await exclude.click();
    await page.locator('.ant-popconfirm').getByRole('button', { name: 'Хасах', exact: true }).click();
    await expect.poll(() => world.resolves).toEqual([{ ids: ['s-income'], action: 'EXCLUDE' }]);
    await expect(toast(page, /1 дохиог тооцооноос хаслаа/)).toBeVisible();
  });

  test('the push toast no longer talks about the internal "step 8"', async ({ page }) => {
    await setup(page);
    await page.goto(OVERVIEW_URL);
    await page.getByRole('button', { name: 'Системрүү татах' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Системрүү татаж, түгжих' }).click();
    const t = toast(page, /Зээлийн хүсэлтэд дамжууллаа/);
    await expect(t).toBeVisible();
    await expect(t).not.toContainText('алхам 8');
  });
});
