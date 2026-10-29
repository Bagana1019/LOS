import { expect, test, type Page } from '@playwright/test';
import type { UserRole } from '@los/contracts';
import { IDS } from '../src/features/collateral/collateral.fixtures';
import { makeDocument, makeRow } from '../src/features/documents/documents.fixtures';
import { CHECKLIST, installDocumentsApi, newDocWorld, type DocWorld } from './documents-mock';
import { expectClean, expectNoHorizontalScroll } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Баримтын алхам (`/los/loan-application/:id/document`): checklist, файл байршуулалт (dms → origination), нэмэлт баримт, OCR, татах, хасах.
// Backend-гүй: e2e/documents-mock.ts.

const PAGE = `/los/loan-application/${IDS.app}/document`;
const DOCUMENTS = '/applications/:aid/documents';

async function setup(page: Page, overrides: Partial<DocWorld> = {}, role: UserRole = 'OFFICER') {
  const api = new MockApi(role);
  const world = installDocumentsApi(api, newDocWorld(overrides));
  await api.install(page);
  const guard = guardConsole(page);
  return { api, world, guard };
}

const row = (page: Page, key: string) => page.locator(`[data-testid="checklist-row"][data-key="${key}"]`);
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 DEMO') });
const dialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });

test.describe('Checklist ба хураангуй (FR-9.2)', () => {
  test('мөр бүр нэр, заавал/дутуу шошготой; «x / y заавал баримт»', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);
    await expect(page.getByRole('heading', { name: 'Баримт бичиг', level: 4 })).toBeVisible();
    await expect(page.getByTestId('document-progress')).toHaveText('0 / 2 заавал баримт');
    await expect(page.getByTestId('document-summary')).toContainText('Дутуу: Иргэний үнэмлэх, Орлогын тодорхойлолт');
    await expect(page.getByTestId('document-step-state')).toHaveText('Алхам дутуу');
    await expect(page.getByTestId('checklist-row')).toHaveCount(CHECKLIST.length);

    await expect(row(page, 'id_card')).toContainText('Иргэний үнэмлэх');
    await expect(row(page, 'id_card')).toContainText('Заавал');
    await expect(row(page, 'id_card')).toContainText('Дутуу');
    await expect(row(page, 'id_card')).toContainText('Файл хавсаргаагүй');
    await expect(row(page, 'photo')).toContainText('Заавал биш');
    await expect(page.getByTestId('extra-documents')).toContainText('Нэмэлт баримт алга');
    expectClean(guard, api);
  });

  test('бүтээгдэхүүн сонгоогүй: checklist тодорхойгүй, «Зээл» алхам руу холбоос', async ({ page }) => {
    const { api, guard } = await setup(page, { rows: [], productMissing: true });
    await page.goto(PAGE);
    await expect(page.getByText('Бүтээгдэхүүн сонгоогүй тул баримтын checklist тодорхойгүй байна.')).toBeVisible();
    await expect(page.getByRole('link', { name: '«Зээл» алхам руу очих' })).toHaveAttribute('href', `/los/loan-application/${IDS.app}/loan`);
    expectClean(guard, api);
  });

  test('жагсаалт ачаалж чадаагүй бол алдаа ба «Дахин ачаалах»', async ({ page }) => {
    const api = new MockApi('OFFICER');
    const world = newDocWorld();
    installDocumentsApi(api, world);
    let fail = true;
    api.get(DOCUMENTS, () => (fail ? { status: 503, json: { code: 'UPSTREAM', message: 'Service Unavailable' } } : { json: { items: [], checklist: [], extras: [], summary: { productMissing: false, required: 0, satisfied: 0, complete: true, missing: [] } } }));
    await api.install(page);
    const guard = guardConsole(page);
    await page.goto(PAGE);
    const alert = page.locator('.ant-alert[role="alert"]');
    await expect(alert).toContainText('Баримтын жагсаалтыг ачаалж чадсангүй');
    fail = false;
    await alert.getByRole('button', { name: 'Дахин ачаалах' }).click();
    await expect(page.getByText('Энэ checklist-д заавал баримт байхгүй.')).toBeVisible();
    expectClean(guard, api);
  });
});

test.describe('Файл хавсаргах (FR-9.1)', () => {
  test('checklist мөр: dms-д байршуулаад, зээлдэгчид холбож хавсаргана; хураангуй шинэчлэгдэнэ', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);

    await row(page, 'id_card').getByRole('button', { name: 'Файл хавсаргах: Иргэний үнэмлэх' }).click();
    const modal = dialog(page, 'Баримт хавсаргах: Иргэний үнэмлэх');
    await expect(modal).toBeVisible();

    // Файлгүй бол илгээхгүй
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal.getByText('Файл сонгоно уу')).toBeVisible();
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(0);

    await modal.locator('input[type=file]').setInputFiles(pdf('id-front.pdf'));
    await expect(modal.getByTestId('attach-file-name')).toContainText('id-front.pdf');
    await choose(page, modal, 'Холбогдох зээлдэгч', 'Бат Болд · УБ******78 · Үндсэн зээлдэгч');
    await modal.getByLabel('Тайлбар').fill('Урд тал');
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal).toBeHidden();

    // Эхлээд dms (multipart), дараа нь origination
    const order = api.calls.map((c) => `${c.method} ${c.path}`).filter((p) => p === 'POST /dms/files' || p === `POST /applications/${IDS.app}/documents`);
    expect(order).toEqual(['POST /dms/files', `POST /applications/${IDS.app}/documents`]);
    const upload = api.lastCall('POST', '/dms/files')!;
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(String(upload.body)).toContain('name="file"; filename="id-front.pdf"');
    expect(api.lastCall('POST', DOCUMENTS)?.body).toEqual({
      fileId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      checklistKey: 'id_card',
      relatedEntity: 'BORROWER',
      relatedId: IDS.owner,
      note: 'Урд тал',
    });

    await expect(row(page, 'id_card')).toContainText('id-front.pdf');
    await expect(row(page, 'id_card')).toContainText('Хангагдсан');
    await expect(row(page, 'id_card')).toContainText('Зээлдэгч: Бат Болд');
    await expect(row(page, 'id_card')).toContainText('Урд тал');
    await expect(page.getByTestId('document-progress')).toHaveText('1 / 2 заавал баримт');
    await expect(page.getByTestId('document-summary')).toContainText('Дутуу: Орлогын тодорхойлолт');

    // Хоёр дахь заавал баримт → алхам бүрдэнэ
    await row(page, 'income_proof').getByRole('button', { name: 'Файл хавсаргах: Орлогын тодорхойлолт' }).click();
    const second = dialog(page, 'Баримт хавсаргах: Орлогын тодорхойлолт');
    await second.locator('input[type=file]').setInputFiles(pdf('income.pdf'));
    await second.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(second).toBeHidden();
    expect(api.lastCall('POST', DOCUMENTS)?.body).toEqual({ fileId: expect.any(String), checklistKey: 'income_proof', relatedEntity: 'APPLICATION' });
    await expect(page.getByTestId('document-progress')).toHaveText('2 / 2 заавал баримт');
    await expect(page.getByTestId('document-summary')).toContainText('Заавал баримт бүрэн хавсаргагдсан.');
    await expect(page.getByTestId('document-step-state')).toHaveText('Алхам бүрдсэн');
    expectClean(guard, api);
  });

  test('нэмэлт баримт: тайлбар заавал (dms-д илүү файл үлдээхгүй), type=other', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);
    await page.getByRole('button', { name: 'Нэмэлт баримт нэмэх' }).first().click();
    const modal = dialog(page, 'Нэмэлт баримт хавсаргах');
    await modal.locator('input[type=file]').setInputFiles({ name: 'hashaa.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal.getByText('Нэмэлт баримтад тайлбар заавал бичнэ')).toBeVisible();
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(0); // шалгалт байршуулахаас өмнө
    expect(api.callsTo('POST', DOCUMENTS)).toHaveLength(0);

    await modal.getByLabel('Тайлбар').fill('Хашааны зураг');
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal).toBeHidden();
    expect(api.lastCall('POST', DOCUMENTS)?.body).toEqual({ fileId: expect.any(String), type: 'other', relatedEntity: 'APPLICATION', note: 'Хашааны зураг' });
    const extra = page.getByTestId('extra-documents');
    await expect(extra).toContainText('hashaa.png');
    await expect(extra).toContainText('Хашааны зураг');
    // Заавал баримтын тоо өөрчлөгдөөгүй
    await expect(page.getByTestId('document-progress')).toHaveText('0 / 2 заавал баримт');
    expectClean(guard, api);
  });

  test('хавсралт 409 (хүсэлтийн төлөв солигдсон): мессеж харагдана; дахин оролдоход файлыг дахин байршуулахгүй', async ({ page }) => {
    const { api, guard, world } = await setup(page);
    await page.goto(PAGE);
    await row(page, 'income_proof').getByRole('button', { name: 'Файл хавсаргах: Орлогын тодорхойлолт' }).click();
    const modal = dialog(page, 'Баримт хавсаргах: Орлогын тодорхойлолт');
    await modal.locator('input[type=file]').setInputFiles(pdf('income.pdf'));
    world.editable = false;
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal.getByRole('alert')).toContainText('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө');
    await expect(modal).toBeVisible();
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(1);

    world.editable = true;
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal).toBeHidden();
    expect(api.callsTo('POST', '/dms/files')).toHaveLength(1); // ижил файл дахин байршаагүй
    expect(api.callsTo('POST', DOCUMENTS)).toHaveLength(2);
    await expect(row(page, 'income_proof')).toContainText('income.pdf');
    expectClean(guard, api);
  });

  test('байршуулалт амжилтгүй (415): монгол мессеж, хавсралт хийгдэхгүй', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.post('/dms/files', { status: 415, json: { code: 'FILE_TYPE_NOT_ALLOWED', message: 'Unsupported Media Type' } });
    await page.goto(PAGE);
    await row(page, 'id_card').getByRole('button', { name: 'Файл хавсаргах: Иргэний үнэмлэх' }).click();
    const modal = dialog(page, 'Баримт хавсаргах: Иргэний үнэмлэх');
    await modal.locator('input[type=file]').setInputFiles(pdf('virus.pdf'));
    await modal.getByRole('button', { name: 'Хавсаргах' }).click();
    await expect(modal.getByRole('alert')).toContainText('Энэ төрлийн файл зөвшөөрөгдөөгүй');
    expect(api.callsTo('POST', DOCUMENTS)).toHaveLength(0);
    expectClean(guard, api);
  });

  test('Esc товчоор модал хаагдана', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(PAGE);
    await row(page, 'id_card').getByRole('button', { name: 'Файл хавсаргах: Иргэний үнэмлэх' }).click();
    const modal = dialog(page, 'Баримт хавсаргах: Иргэний үнэмлэх');
    await expect(modal).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.ant-modal-wrap'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    expectClean(guard, api);
  });
});

test.describe('Баримтын үйлдлүүд', () => {
  const withIdCard = () => ({
    rows: [
      makeRow({ key: 'id_card', name: 'Иргэний үнэмлэх', documents: [makeDocument({ relatedEntity: 'BORROWER', relatedId: IDS.owner })] }),
      makeRow({ key: 'income_proof', name: 'Орлогын тодорхойлолт', documents: [makeDocument({ id: '0a1b2c3d-7777-4a77-8a77-000000000002', checklistKey: 'income_proof', type: 'income_proof', fileName: 'income.pdf' })] }),
    ],
  });

  test('OCR: зөвхөн иргэний үнэмлэхийн мөрөнд; дүгнэлт, далдлагдсан регистр, зөвлөмж', async ({ page }) => {
    const { api, guard } = await setup(page, withIdCard());
    await page.goto(PAGE);
    await expect(row(page, 'income_proof').getByRole('button', { name: /^OCR шалгах/ })).toHaveCount(0);

    await row(page, 'id_card').getByRole('button', { name: 'OCR шалгах: id-front.pdf' }).click();
    const result = row(page, 'id_card').getByTestId('ocr-result');
    await expect(result).toContainText('Регистр таарсан');
    await expect(result).toContainText('Регистр: УБ****5678');
    await expect(result).toContainText('Итгэлцэл: 93%');
    await expect(result).toContainText('Үнэмлэхний регистр зээлдэгчийн регистртэй таарч байна.');
    await expect(result).toContainText('OCR нь зөвлөмж бөгөөд эцсийн баталгаажуулалтыг ажилтан хийнэ.');
    await expect(result).toHaveAttribute('role', 'status');
    expect(api.callsTo('POST', `${DOCUMENTS}/:docId/ocr`)).toHaveLength(1);
    expectClean(guard, api);
  });

  test('OCR таарахгүй, уншигдаагүй: анхааруулга, зөвлөмж', async ({ page }) => {
    const { api, guard, world } = await setup(page, { ...withIdCard(), ocrVerdict: 'MISMATCH', ocrWarnings: ['Регистр зээлдэгчийнхээс ялгаатай', 'low image quality'] });
    await page.goto(PAGE);
    const button = row(page, 'id_card').getByRole('button', { name: 'OCR шалгах: id-front.pdf' });
    await button.click();
    const result = row(page, 'id_card').getByTestId('ocr-result');
    await expect(result).toContainText('Регистр таарахгүй');
    await expect(result).toContainText('Баримтыг гараар шалгана уу.');
    await expect(result).toContainText('Регистр зээлдэгчийнхээс ялгаатай');
    await expect(result).toContainText('OCR анхааруулга гарсан — баримтыг гараар шалгана уу.'); // англи анхааруулга нийтлэг тайлбараар
    await expect(result).not.toContainText('low image quality');

    world.ocrVerdict = 'UNREADABLE';
    await button.click();
    await expect(result).toContainText('Уншигдаагүй');
    await expect(result).toContainText('Үнэмлэхээс регистрийг уншиж чадсангүй.');
    expectClean(guard, api);
  });

  test('татах: dms-ээс authFetch-ээр блоб авч хадгална', async ({ page }) => {
    const { api, guard } = await setup(page, withIdCard());
    await page.goto(PAGE);
    const download = page.waitForEvent('download');
    await row(page, 'income_proof').getByRole('button', { name: 'Татах: income.pdf' }).click();
    expect((await download).suggestedFilename()).toBe('income.pdf');
    expect(api.callsTo('GET', '/dms/files/:id/content')).toHaveLength(1);
    expect(api.lastCall('GET', '/dms/files/:id/content')?.params.id).toBe('0a1b2c3d-4444-4a44-8a44-000000000001');
    expect(api.lastCall('GET', '/dms/files/:id/content')?.headers.authorization).toMatch(/^Bearer token-/);
    expectClean(guard, api);
  });

  test('хасах: баталгаажуулалттай; хураангуй шинэчлэгдэнэ', async ({ page }) => {
    const { api, guard } = await setup(page, withIdCard());
    await page.goto(PAGE);
    await expect(page.getByTestId('document-progress')).toHaveText('2 / 2 заавал баримт');

    await row(page, 'income_proof').getByRole('button', { name: 'Хасах: income.pdf' }).click();
    const confirm = page.locator('.ant-popover');
    await expect(confirm).toContainText('Баримтыг хасах уу?');
    await confirm.getByRole('button', { name: 'Болих' }).click();
    expect(api.callsTo('DELETE', `${DOCUMENTS}/:docId`)).toHaveLength(0);

    await row(page, 'income_proof').getByRole('button', { name: 'Хасах: income.pdf' }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Хасах', exact: true }).click();
    await expect(row(page, 'income_proof')).toContainText('Файл хавсаргаагүй');
    await expect(page.getByTestId('document-progress')).toHaveText('1 / 2 заавал баримт');
    await expect(page.getByTestId('document-step-state')).toHaveText('Алхам дутуу');
    expect(api.callsTo('DELETE', `${DOCUMENTS}/:docId`)).toHaveLength(1);
    expectClean(guard, api);
  });
});

test.describe('Эрх ба төлөв', () => {
  test('хүсэлт засах боломжгүй төлөвт: хавсаргах, хасах, OCR хаалттай; татаж болно', async ({ page }) => {
    const { api, guard } = await setup(page, { editable: false, rows: [makeRow({ key: 'id_card', name: 'Иргэний үнэмлэх', documents: [makeDocument()] })] });
    await page.goto(PAGE);
    await expect(page.getByText('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт биш тул баримтыг өөрчлөх боломжгүй.')).toBeVisible();
    await expect(row(page, 'id_card').getByRole('button', { name: 'Файл хавсаргах: Иргэний үнэмлэх' })).toBeDisabled();
    await expect(row(page, 'id_card').getByRole('button', { name: 'Хасах: id-front.pdf' })).toBeDisabled();
    await expect(row(page, 'id_card').getByRole('button', { name: 'OCR шалгах: id-front.pdf' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Нэмэлт баримт нэмэх' }).first()).toBeDisabled();
    await expect(row(page, 'id_card').getByRole('button', { name: 'Татах: id-front.pdf' })).toBeEnabled();
    expectClean(guard, api);
  });

  test('бичих эрхгүй дүр: зөвхөн харна', async ({ page }) => {
    const { api, guard } = await setup(page, {}, 'BRANCH_MANAGER');
    await page.goto(PAGE);
    await expect(page.getByText('Таны дүрд баримт өөрчлөх эрх байхгүй (зөвхөн харах).')).toBeVisible();
    await expect(row(page, 'id_card').getByRole('button', { name: 'Файл хавсаргах: Иргэний үнэмлэх' })).toBeDisabled();
    expectClean(guard, api);
  });
});

test.describe('Утасны дэлгэц (375px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('checklist, модал хэвтээ гүйлгэгдэхгүй; интерактив элемент нэртэй, id давхцахгүй', async ({ page }) => {
    const { api, guard } = await setup(page, {
      rows: [
        makeRow({ key: 'id_card', name: 'Иргэний үнэмлэх', documents: [makeDocument({ fileName: 'ger-bulyn-turshlagyn-tohooromjiin-ner-urt-ner-uruu.pdf', relatedEntity: 'BORROWER', relatedId: IDS.owner, note: 'Урд ба ар талын хуулбар' })] }),
        makeRow({ key: 'income_proof', name: 'Орлогын тодорхойлолт' }),
      ],
      extras: [makeDocument({ id: '0a1b2c3d-7777-4a77-8a77-000000000009', type: 'other', checklistKey: null, fileName: 'zurag.png', note: 'Хашааны зураг' })],
    });
    await page.goto(PAGE);
    await expect(page.getByTestId('checklist-row')).toHaveCount(2);
    await expectNoHorizontalScroll(page);
    await expectAccessibleBasics(page);

    await row(page, 'income_proof').getByRole('button', { name: 'Файл хавсаргах: Орлогын тодорхойлолт' }).click();
    const modal = dialog(page, 'Баримт хавсаргах: Орлогын тодорхойлолт');
    await modal.locator('input[type=file]').setInputFiles(pdf('income-with-a-very-long-file-name-that-should-wrap-instead-of-overflowing-the-viewport.pdf'));
    await expect(modal.getByTestId('attach-file-name')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessibleBasics(page);
    expectClean(guard, api);
  });
});

async function choose(page: Page, scope: ReturnType<Page['locator']>, label: string, option: string) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: option }).first().click();
}

/** Харагдаж буй товч, оролт бүрийн хүртгэлтэй нэр, давхардсан id. */
async function expectAccessibleBasics(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const nameOf = (el: Element): string => {
      const e = el as HTMLElement;
      const aria = e.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelledBy = e.getAttribute('aria-labelledby');
      if (labelledBy && labelledBy.split(/\s+/).map((i) => document.getElementById(i)?.textContent?.trim() ?? '').join('').trim()) return 'labelled';
      if (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim()) return 'label';
      if (e.closest('label')?.textContent?.trim()) return 'label';
      return (e.textContent?.trim() || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
    };
    for (const el of Array.from(document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, [role=combobox], [role=tab], [role=radio]'))) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (!nameOf(el)) out.push(`no accessible name: <${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 60)}">`);
    }
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1 && !id.startsWith('rc_')) out.push(`duplicate id "${id}" x${n}`);
    return out;
  });
  expect(problems, 'accessibility basics').toEqual([]);
}
