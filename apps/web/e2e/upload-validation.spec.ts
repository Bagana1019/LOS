import { expect, test, type Locator, type Page } from '@playwright/test';
import { IDS, makeCollateral } from '../src/features/collateral/collateral.fixtures';
import { installCollateralApi, newWorld } from './collateral-mock';
import { installDocumentsApi, newDocWorld } from './documents-mock';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F4-12 / F1-12 (shared): FileUploadButton буруу файлыг (virus.exe, 0 байт, хэт том) чимээгүй хаядаг байсан.
// Одоо: хүсэлт явуулахгүй, файлын нэр + зөвшөөрөгдөх төрөл + дээд хэмжээг нэрлэсэн message.error.
// Хязгаар нь dms-тэй таарна (apps/dms file-type.ts, file.service.ts: 20 МБ). Backend-гүй: e2e/documents-mock.ts, e2e/collateral-mock.ts.

const DOC_PAGE = `/los/loan-application/${IDS.app}/document`;
const COLLATERAL_PAGE = `/los/loan-application/${IDS.app}/collateral`;
const LIMITS = 'Зөвшөөрөгдөх төрөл: PDF, PNG, JPG, JPEG, DOCX, XLSX, CSV, TXT. Дээд хэмжээ: 20 МБ.';
const MB = 1024 * 1024;

const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 DEMO') });
const exe = { name: 'virus.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') };
const toast = (page: Page) => page.locator('.ant-message-custom-content.ant-message-error');

async function openAttachModal(page: Page, api: MockApi) {
  await api.install(page);
  await page.goto(DOC_PAGE);
  await page.getByTestId('checklist-row').filter({ hasText: 'Иргэний үнэмлэх' }).getByRole('button', { name: 'Файл хавсаргах: Иргэний үнэмлэх' }).click();
  const modal = page.getByRole('dialog', { name: 'Баримт хавсаргах: Иргэний үнэмлэх' });
  await expect(modal).toBeVisible();
  return modal;
}

async function attachWorld(page: Page) {
  const api = new MockApi('OFFICER');
  installDocumentsApi(api, newDocWorld());
  const guard = guardConsole(page);
  const modal = await openAttachModal(page, api);
  return { api, guard, modal };
}

test.describe('Баримт хавсаргах цонх (documents step)', () => {
  test('virus.exe: хүсэлтгүй, файлын нэр + төрөл + хэмжээг нэрлэсэн алдаа; сонгосон файл гарахгүй', async ({ page }) => {
    const { api, guard, modal } = await attachWorld(page);
    await modal.locator('input[type=file]').setInputFiles(exe);
    await expect(toast(page)).toHaveText(`«virus.exe» файл дэмжигдэхгүй байна. ${LIMITS}`);
    await expect(modal.getByTestId('attach-file-name')).toHaveCount(0);
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(0);
    expectClean(guard, api);
  });

  test('0 байт файл: «хоосон» гэж нэрлэсэн алдаа, хүсэлтгүй', async ({ page }) => {
    const { api, guard, modal } = await attachWorld(page);
    await modal.locator('input[type=file]').setInputFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
    await expect(toast(page)).toHaveText(`«empty.pdf» файл хоосон байна (0 байт). ${LIMITS}`);
    await expect(modal.getByTestId('attach-file-name')).toHaveCount(0);
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(0);
    expectClean(guard, api);
  });

  test('20 МБ-аас том файл: «хэт том» алдаа, хүсэлтгүй', async ({ page }) => {
    const { api, guard, modal } = await attachWorld(page);
    await modal.locator('input[type=file]').setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(25 * MB, 0x20) });
    await expect(toast(page)).toHaveText(`«huge.pdf» файл хэт том байна. ${LIMITS}`);
    await expect(modal.getByTestId('attach-file-name')).toHaveCount(0);
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(0);
    expectClean(guard, api);
  });

  test('өмнө сонгосон зөв файл буруу файл сонгоход алдагдахгүй; дараа нь зөв файл хэвийн хавсарна', async ({ page }) => {
    const { api, guard, modal } = await attachWorld(page);
    const input = modal.locator('input[type=file]');
    await input.setInputFiles(pdf('id-front.pdf'));
    await expect(modal.getByTestId('attach-file-name')).toContainText('id-front.pdf');
    await input.setInputFiles(exe);
    await expect(toast(page)).toContainText('«virus.exe»');
    await expect(modal.getByTestId('attach-file-name')).toContainText('id-front.pdf');

    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal).toBeHidden();
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(1);
    expectClean(guard, api);
  });

  test('зөвшөөрөгдөх төрөл (том үсэгтэй өргөтгөл) алдаагүй; тайлбар дээр дээд хэмжээг урьдчилж харуулна', async ({ page }) => {
    const { api, guard, modal } = await attachWorld(page);
    await expect(modal.getByText('PDF, PNG, JPG, JPEG, DOCX, XLSX, CSV, TXT. Дээд хэмжээ: 20 МБ.')).toBeVisible();
    await modal.locator('input[type=file]').setInputFiles({ name: 'SCAN.PDF', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(modal.getByTestId('attach-file-name')).toContainText('SCAN.PDF');
    await expect(toast(page)).toHaveCount(0);
    expectClean(guard, api);
  });
});

test.describe('Барьцааны баримт (shared FileUploadButton автоматаар)', () => {
  const openDocumentsTab = async (page: Page): Promise<Locator> => {
    await page.getByTestId('collateral-card').first().getByRole('button', { name: /^Дэлгэрэнгүй/ }).click();
    const drawer = page.getByRole('dialog').last();
    await expect(drawer).toBeVisible();
    const tab = drawer.getByRole('tab', { name: 'Баримт' });
    await expect(async () => {
      await tab.click({ timeout: 2_000 });
      await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return drawer;
  };

  test('checklist мөрөнд virus.exe: алдаа гарна, хүсэлтгүй, мөр «Файл хавсаргаагүй» хэвээр', async ({ page }) => {
    const api = new MockApi('OFFICER');
    installCollateralApi(api, newWorld({ items: [makeCollateral()] }));
    await api.install(page);
    const guard = guardConsole(page);
    await page.goto(COLLATERAL_PAGE);
    const drawer = await openDocumentsTab(page);
    const row = drawer.locator('[data-testid="collateral-checklist-row"][data-key="vehicle_certificate"]');

    await row.locator('input[type=file]').setInputFiles(exe);
    await expect(toast(page)).toHaveText(`«virus.exe» файл дэмжигдэхгүй байна. ${LIMITS}`);
    await expect(row).toContainText('Файл хавсаргаагүй');
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(0);
    expectClean(guard, api);
  });
});
