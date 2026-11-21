import { expect, test, type Page } from '@playwright/test';
import { AttachSignedContractRequest, ContractView } from '@los/contracts';
import { installDms } from './collateral-mock';
import { expectClean } from './helpers';
import { guardConsole, MockApi, type MockHandler } from './mock-api';

// Wizard-ийн «Гэрээ» алхам (`/los/loan-application/:id/contract`, FR-11.3). Gateway-г mock хийсэн.
// F4-13: цаасан гарын үсгийн сканы picker ямар ч файл авч, баталгаажуулалтгүйгээр гэрээг «Гарын үсэг зурагдсан» болгодог байсан.
const APP_ID = '00000000-0000-4000-8000-0000000000c4';
const URL = `/los/loan-application/${APP_ID}/contract`;
const NOW = '2026-11-21T03:00:00.000Z';
const TYPE_MESSAGE = 'Гарын үсэгтэй гэрээний скан зөвхөн PDF, PNG, JPG байх ёстой';
const CONFIRM_TITLE = 'Гарын үсэг зурагдсан гэж тэмдэглэх үү?';
const ATTACHED_TOAST = 'Гарын үсэгтэй гэрээ хавсарлаа';
const SIGNED_TAG = 'Гарын үсэг зурагдсан';
const CONTRACT = '/applications/:id/contract';
const ATTACH = '/applications/:id/contract/signed';
const DMS = '/dms/files';

const view = (o: Partial<ContractView> = {}): ContractView =>
  ContractView.parse({
    id: 'c-1', applicationId: APP_ID, contractNo: 'LC-2026-0001', templateVersion: 1, generatedFileId: 'file-gen-1', signedFileId: null, signedAt: null, signChannel: 'PAPER', signingStatus: null, ...o,
  });

const file = (name: string, mimeType: string) => ({ name, mimeType, buffer: Buffer.from('%PDF-1.4 DEMO') }); // 13 байт
const pdf = (name = 'contract-signed.pdf') => file(name, 'application/pdf');
const txt = () => file('notes.txt', 'text/plain');

/** Жинхэнэ сервер шиг: хавсаргасны дараа гэрээ «Гарын үсэг зурагдсан» болно. `attach`-аар сервер талын алдааг дуурайна. */
async function setup(page: Page, attach?: MockHandler) {
  const api = new MockApi('OFFICER');
  const world = { contract: view(), uploads: [] as Array<{ id: string; name: string }>, seq: 0 };
  api.get(CONTRACT, () => ({ json: { contract: world.contract, letters: [] } }));
  api.get('/contracts/:id/esign', { status: 404, json: { code: 'NOT_FOUND', message: 'Хүсэлт байхгүй' } }); // цахим гарын үсгийн самбар
  installDms(api, world.uploads, () => ++world.seq);
  api.post(ATTACH, attach ?? (({ body }) => {
    const req = AttachSignedContractRequest.parse(body);
    world.contract = view({ signedFileId: req.fileId, signedAt: NOW, signChannel: 'PAPER' });
    return { status: 201, json: world.contract };
  }));
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, world };
}

const fileInput = (page: Page) => page.locator('input[type=file]');
const dialog = (page: Page) => page.getByRole('dialog');
const dmsUploads = (api: MockApi) => api.callsTo('POST', DMS);
const attaches = (api: MockApi) => api.callsTo('POST', ATTACH);
const openStep = async (page: Page) => {
  await page.goto(URL);
  await expect(page.getByTestId('contract-generate')).toBeVisible();
  await expect(fileInput(page)).toHaveCount(1);
};

test.describe('Гэрээ: гарын үсэгтэй скан хавсаргах (F4-13)', () => {
  test('the picker offers only pdf, png, jpg and jpeg', async ({ page }) => {
    await setup(page);
    await openStep(page);
    await expect(fileInput(page)).toHaveAttribute('accept', '.pdf,.png,.jpg,.jpeg');
  });

  test('a .txt file is rejected before any upload and the contract stays unsigned', async ({ page }) => {
    const { api, guard } = await setup(page);
    await openStep(page);
    await fileInput(page).setInputFiles(txt());
    await expect(page.getByText(TYPE_MESSAGE)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(dmsUploads(api)).toHaveLength(0);
    expect(attaches(api)).toHaveLength(0);
    await expect(page.getByText(ATTACHED_TOAST)).toHaveCount(0);
    await expect(page.locator('.ant-tag', { hasText: SIGNED_TAG })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('a pdf asks for confirmation with file name and size; cancelling sends nothing', async ({ page }) => {
    const { api } = await setup(page);
    await openStep(page);
    await fileInput(page).setInputFiles(pdf());
    await expect(dialog(page)).toContainText(CONFIRM_TITLE);
    await expect(dialog(page)).toContainText('contract-signed.pdf');
    await expect(dialog(page)).toContainText('13 Б');
    expect(dmsUploads(api)).toHaveLength(0);
    expect(attaches(api)).toHaveLength(0);

    await dialog(page).getByRole('button', { name: 'Болих' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(dmsUploads(api)).toHaveLength(0);
    expect(attaches(api)).toHaveLength(0);
    await expect(page.locator('.ant-tag', { hasText: SIGNED_TAG })).toHaveCount(0);
  });

  test('confirming uploads the file and only then attaches it; the contract becomes signed', async ({ page }) => {
    const { api, guard, world } = await setup(page);
    await openStep(page);
    await fileInput(page).setInputFiles(pdf());
    await dialog(page).getByRole('button', { name: 'Тийм, тэмдэглэх' }).click();

    await expect(page.getByText(ATTACHED_TOAST)).toBeVisible();
    await expect(page.locator('.ant-tag', { hasText: SIGNED_TAG })).toBeVisible();
    const order = api.calls.map((c) => `${c.method} ${c.path}`).filter((p) => p === `POST ${DMS}` || p === `POST /applications/${APP_ID}/contract/signed`);
    expect(order).toEqual([`POST ${DMS}`, `POST /applications/${APP_ID}/contract/signed`]);
    expect(attaches(api)[0]!.body).toEqual({ fileId: world.uploads[0]!.id });
    expectClean(guard, api);
  });

  for (const [label, f] of [
    ['png', file('scan-page1.png', 'image/png')],
    ['uppercase JPG', file('SCAN-PAGE1.JPG', 'image/jpeg')],
  ] as const) {
    test(`a ${label} is accepted and reaches the confirmation`, async ({ page }) => {
      const { api } = await setup(page);
      await openStep(page);
      await fileInput(page).setInputFiles(f);
      await expect(dialog(page)).toContainText(CONFIRM_TITLE);
      expect(dmsUploads(api)).toHaveLength(0);
    });
  }

  test('a 415 SIGNED_SCAN_TYPE_NOT_ALLOWED from the server is shown with the type message and nothing is marked signed', async ({ page }) => {
    const { api } = await setup(page, () => ({ status: 415, json: { code: 'SIGNED_SCAN_TYPE_NOT_ALLOWED', message: 'Файлын төрөл зөвшөөрөгдөөгүй' } }));
    await openStep(page);
    await fileInput(page).setInputFiles(pdf());
    await dialog(page).getByRole('button', { name: 'Тийм, тэмдэглэх' }).click();

    await expect(page.getByRole('alert').filter({ hasText: TYPE_MESSAGE }).first()).toBeVisible();
    await expect(page.getByText(ATTACHED_TOAST)).toHaveCount(0);
    await expect(page.locator('.ant-tag', { hasText: SIGNED_TAG })).toHaveCount(0);
    expect(attaches(api)).toHaveLength(1);
  });
});
