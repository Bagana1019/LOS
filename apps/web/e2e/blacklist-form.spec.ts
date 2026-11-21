import { expect, test, type Page } from '@playwright/test';
import { guardConsole, MockApi } from './mock-api';

// Chrome naive-user test, F8: «Хар жагсаалт»-ийн нэмэх/засах маягт.
//   F8-4 серверийн алдаа монгол + талбар заасан · F8-5 шалтгаан монгол нэрээр хайгдана
//   F8-6 Хар нэмэхэд "батлах хүсэлт илгээгдлээ" · F8-7 жагсаалтын ангилал өгөгдмөлгүй, заавал

const ID = '55555555-5555-4555-8555-555555555551';
const entry = (over: Record<string, unknown> = {}) => ({
  id: ID, orgId: 'org', registerNo: 'УБ12345678', customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT', severity: 'GREY',
  reasonCode: 'SUSPICION', reasonText: null, source: 'INTERNAL', validUntil: null, deactivationReason: null, pendingSeverity: null, isActive: true, registeredBy: 'u1', registeredAt: '2026-11-03T00:00:00.000Z', ...over,
});

async function setup(page: Page) {
  const api = new MockApi('ADMIN');
  await api.install(page);
  const guard = guardConsole(page);
  api.get('/blacklist', { json: { total: 1, items: [entry()] } });
  await page.goto('/los/blacklist');
  return { api, guard };
}

const dialog = (page: Page) => page.getByRole('dialog');
const openAdd = async (page: Page) => { await page.getByTestId('add-blacklist').click(); await expect(dialog(page)).toBeVisible(); };
const save = (page: Page) => dialog(page).getByRole('button', { name: 'Хадгалах' }).click();
const toast = (page: Page) => page.locator('.ant-message-notice');
const fieldError = (page: Page, label: string) => dialog(page).locator('.ant-form-item', { hasText: label }).locator('.ant-form-item-explain-error');

/** antd Select: хайлтгүй Select-ийн input нь далд тул `.ant-select` бүхлийг дарж нээгээд, нээлттэй жагсаалтаас яг энэ нэртэй сонголтыг дарна (хаагдсан жагсаалтууд DOM-д үлддэг). */
async function pick(page: Page, label: string, option: string) {
  await dialog(page).locator('.ant-form-item', { hasText: label }).locator('.ant-select').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByTitle(option, { exact: true }).click();
}

async function fillValid(page: Page, o: { listType?: string | null; severity?: 'Хар' | 'Саарал' } = {}) {
  await dialog(page).getByLabel('Регистрийн дугаар').fill('уб 12345678');
  await dialog(page).getByLabel('Нэр', { exact: true }).fill('Шинэ Этгээд');
  if (o.severity === 'Саарал') await dialog(page).getByText('Саарал', { exact: true }).click();
  if (o.listType !== null) await pick(page, 'Жагсаалтын ангилал', o.listType ?? 'Залилан');
  await pick(page, 'Шалтгаан', 'Залилангийн хэрэг');
}

test('F8-7: ангилал өгөгдмөлөөр сонгогдоогүй, заавал — хоосон бол монгол мессеж, хүсэлт явахгүй', async ({ page }) => {
  const { api, guard } = await setup(page);
  api.post('/blacklist', { status: 201, json: entry() });
  await openAdd(page);

  const category = dialog(page).locator('.ant-form-item', { hasText: 'Жагсаалтын ангилал' });
  await expect(category.locator('.ant-select-selection-item')).toHaveCount(0);
  await expect(category.locator('.ant-select-selection-placeholder')).toHaveText('Сонгоно уу');

  await fillValid(page, { listType: null });
  await save(page);
  await expect(fieldError(page, 'Жагсаалтын ангилал')).toHaveText('Жагсаалтын ангиллыг сонгоно уу');
  expect(api.callsTo('POST', '/blacklist')).toHaveLength(0);

  await pick(page, 'Жагсаалтын ангилал', 'Залилан');
  await save(page);
  await expect.poll(() => api.lastCall('POST', '/blacklist')?.body).toMatchObject({ listType: 'FRAUD', reasonCode: 'FRAUD_CASE' });
  expect(api.unhandled).toEqual([]);
  expect(guard.problems).toEqual([]);
});

test('F8-5: шалтгааныг харагдах монгол нэрээр хайна; олдохгүй бол монгол текст', async ({ page }) => {
  await setup(page);
  await openAdd(page);
  const reason = dialog(page).getByLabel('Шалтгаан', { exact: true });
  const open = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');

  await reason.click();
  await reason.fill('Сэжиг');
  await expect(open.getByTitle('Сэжигтэй үйл ажиллагаа', { exact: true })).toBeVisible();
  await expect(open.getByTitle('Шүүхийн шийдвэр', { exact: true })).toHaveCount(0);

  await reason.fill('зуурмаг');
  await expect(open.getByText('Тохирох шалтгаан олдсонгүй')).toBeVisible();
  await expect(open.getByText(/Мэдээлэл байхгүй|No data/)).toHaveCount(0);
});

test('F8-6: Хар нэмэхэд toast нь батлах хүсэлт илгээгдсэнийг хэлж, хаана батлахыг заана; Саарал нь "Хадгаллаа"', async ({ page }) => {
  const { api, guard } = await setup(page);
  api.post('/blacklist', ({ body }) => {
    const b = body as { severity: string };
    return { status: 201, json: b.severity === 'BLACK' ? entry({ ...b, severity: 'GREY', isActive: false, pendingSeverity: 'BLACK' }) : entry({ ...b }) };
  });

  await openAdd(page);
  await fillValid(page); // анхдагч түвшин: Хар
  await save(page);
  await expect.poll(() => api.lastCall('POST', '/blacklist')?.body).toMatchObject({ severity: 'BLACK' });
  await expect(toast(page)).toContainText('Хар жагсаалтад оруулах хүсэлт илгээгдлээ');
  await expect(toast(page)).toContainText('«Баталгаажуулалт» цэснээс');
  await expect(toast(page)).not.toHaveText(/^Хадгаллаа$/);

  await expect(toast(page)).toHaveCount(0, { timeout: 10_000 });
  await openAdd(page);
  await fillValid(page, { severity: 'Саарал' });
  await save(page);
  await expect(toast(page)).toHaveText('Хадгаллаа');
  expect(guard.problems).toEqual([]);
});

test('F8-6: Саарал мөрийг Хар болгож засахад мөн батлах хүсэлтийн toast', async ({ page }) => {
  const { api } = await setup(page);
  api.on('PATCH', '/blacklist/:id', ({ params, body }) => ({ json: entry({ ...(body as object), id: params.id, severity: 'GREY', pendingSeverity: 'BLACK' }) }));
  await page.getByRole('button', { name: 'Засах' }).first().click();
  await dialog(page).getByText('Хар', { exact: true }).click();
  await save(page);
  await expect.poll(() => api.lastCall('PATCH', '/blacklist/:id')?.body).toMatchObject({ severity: 'BLACK' });
  await expect(toast(page)).toContainText('Хар жагсаалтад оруулах хүсэлт илгээгдлээ');
});

test('F8-4: zod алдаа талбар бүрийн доор монголоор харагдана (англи "Validation failed" харагдахгүй)', async ({ page }) => {
  const { api, guard } = await setup(page);
  api.post('/blacklist', {
    status: 400,
    json: {
      statusCode: 400, message: 'Validation failed',
      issues: [
        { code: 'too_big', path: ['name'], message: 'String must contain at most 200 character(s)' },
        { code: 'invalid_enum_value', path: ['reasonCode'], message: "Invalid enum value. Expected 'OTHER' | 'WATCH'" },
        { code: 'custom', path: ['registerNo'], message: 'registerNo contains unsupported characters' },
      ],
    },
  });
  await openAdd(page);
  await fillValid(page);
  await save(page);

  await expect(fieldError(page, 'Нэр')).toHaveText('Хамгийн ихдээ 200 тэмдэгт байж болно');
  await expect(fieldError(page, 'Шалтгаан')).toHaveText('Жагсаалтаас зөвшөөрөгдсөн утгыг сонгоно уу');
  await expect(fieldError(page, 'Регистрийн дугаар')).toHaveText('Регистрт зөвхөн үсэг, цифр байна (жишээ нь УБ12345678)');
  await expect(dialog(page).getByText('Оруулсан мэдээлэлд алдаа байна. Улаанаар тэмдэглэсэн талбарыг засна уу.')).toBeVisible();
  await expect(page.getByText(/Validation failed|String must contain/)).toHaveCount(0);
  expect(guard.problems).toEqual([]);
});

test('F8-4: 409 давхардал — Монголоор, аль жагсаалт болохыг нэрлэж, Засах руу чиглүүлнэ', async ({ page }) => {
  const { api } = await setup(page);
  api.post('/blacklist', { status: 409, json: { statusCode: 409, message: 'An entry with the same register number and list type already exists', error: 'Conflict' } });
  await openAdd(page);
  await fillValid(page, { listType: 'Залилан' });
  await save(page);

  await expect(dialog(page).getByText('Энэ регистр «Залилан» жагсаалтад аль хэдийн бүртгэлтэй байна. Хүснэгтээс хайж олоод «Засах» товчоор өөрчилнө үү.')).toBeVisible();
  await expect(fieldError(page, 'Регистрийн дугаар')).toHaveText('«Залилан» жагсаалтад бүртгэлтэй');
  await expect(page.getByText(/same register number/)).toHaveCount(0);
});

test('F8-4: өнгөрсөн дуусах огноо — validUntil талбар дээр монгол мессеж', async ({ page }) => {
  const { api } = await setup(page);
  api.post('/blacklist', { status: 400, json: { statusCode: 400, message: 'validUntil must be in the future', error: 'Bad Request' } });
  await openAdd(page);
  await fillValid(page, { severity: 'Саарал' });
  await dialog(page).getByLabel('Дуусах огноо (Саарал)').fill('2020-01-01');
  await save(page);
  await expect(fieldError(page, 'Дуусах огноо')).toHaveText('Дуусах огноо өнгөрсөн байна — ирээдүйн огноо сонгоно уу');
  await expect(page.getByText(/must be in the future/)).toHaveCount(0);
});

test('F8-4: идэвхгүй болгох маягтын 409 (зэрэг засвар) мөн монголоор', async ({ page }) => {
  const { api } = await setup(page);
  api.post('/blacklist/:id/deactivate', { status: 409, json: { statusCode: 409, message: 'Blacklist entry was modified concurrently, retry', error: 'Conflict' } });
  await page.getByRole('button', { name: 'Идэвхгүй болгох' }).first().click();
  await page.getByTestId('deactivation-reason').fill('Төлбөр барагдсан');
  await page.getByRole('dialog').getByRole('button', { name: 'Идэвхгүй болгох' }).click();
  await expect(dialog(page).getByText('Бүртгэлийг өөр хэрэглэгч саяхан өөрчилсөн байна. Хүснэгтийг шинэчлээд дахин оролдоно уу.')).toBeVisible();
  await expect(page.getByText(/modified concurrently/)).toHaveCount(0);
});
