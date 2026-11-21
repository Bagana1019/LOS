import { expect, test, type Page } from '@playwright/test';
import { guardConsole, MockApi } from './mock-api';

// F8-9: хоёр tab-ын зэрэгцээ засвар. Засах маягт ачаалсан `updatedAt`-аа `expectedUpdatedAt` болгон илгээнэ;
// сервер 409 { code: 'BLACKLIST_STALE' } өгвөл монгол мессеж + «Шинэчлэх» (шинэ утгыг татаж маягтыг дахин ачаална).

const ID = '55555555-5555-4555-8555-555555555551';
const LOADED_AT = '2026-11-21T09:00:00.000Z';
const OTHER_AT = '2026-11-21T09:05:00.000Z';
const SAVED_AT = '2026-11-21T09:10:00.000Z';
const STALE_TEXT = 'Бичлэг өөр хэрэглэгчээр өөрчлөгдсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу';
const STALE = { code: 'BLACKLIST_STALE', message: STALE_TEXT };

const entry = (over: Record<string, unknown> = {}) => ({
  id: ID, orgId: 'org', registerNo: 'УБ12345678', customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT', severity: 'GREY',
  reasonCode: 'SUSPICION', reasonText: null, source: 'INTERNAL', validUntil: null, deactivationReason: null, pendingSeverity: null, isActive: true,
  registeredBy: 'u1', registeredAt: '2026-11-03T00:00:00.000Z', updatedAt: LOADED_AT, ...over,
});

async function setup(page: Page, listEntry: Record<string, unknown> = entry()) {
  const api = new MockApi('ADMIN');
  await api.install(page);
  const guard = guardConsole(page);
  api.get('/blacklist', { json: { total: 1, items: [listEntry] } });
  await page.goto('/los/blacklist');
  return { api, guard };
}

const dialog = (page: Page) => page.getByRole('dialog');
const nameField = (page: Page) => dialog(page).getByLabel('Нэр', { exact: true });
const toast = (page: Page) => page.locator('.ant-message-notice');
const save = (page: Page) => dialog(page).getByRole('button', { name: 'Хадгалах' }).click();
const refresh = (page: Page) => dialog(page).getByTestId('blacklist-stale-refresh');
const openEdit = async (page: Page) => { await page.getByRole('button', { name: 'Засах' }).click(); await expect(dialog(page)).toBeVisible(); };

/** Серверийн жинхэнэ дүрэм: зөвхөн одоогийн updatedAt-тай таарсан засварыг хүлээж авна. */
function serverWithCurrent(api: MockApi, current: { at: string }) {
  api.patch('/blacklist/:id', ({ body }) => {
    const b = body as { name: string; expectedUpdatedAt?: string };
    if (b.expectedUpdatedAt !== undefined && b.expectedUpdatedAt !== current.at) return { status: 409, json: STALE };
    return { json: entry({ name: b.name, updatedAt: SAVED_AT }) };
  });
}

test('F8-9: засах маягт ачаалсан updatedAt-аа expectedUpdatedAt болгон илгээнэ, амжилттай бол хаагдана', async ({ page }) => {
  const { api, guard } = await setup(page);
  serverWithCurrent(api, { at: LOADED_AT });

  await openEdit(page);
  await nameField(page).fill('Шинэ нэр');
  await save(page);

  await expect(toast(page)).toHaveText('Хадгаллаа');
  await expect(dialog(page)).toHaveCount(0);
  expect(api.callsTo('PATCH', '/blacklist/:id')).toHaveLength(1);
  expect(api.lastCall('PATCH', '/blacklist/:id')?.body).toMatchObject({ name: 'Шинэ нэр', expectedUpdatedAt: LOADED_AT });
  expect(api.unhandled).toEqual([]);
  expect(guard.problems).toEqual([]);
});

test('F8-9: хуучирсан маягт — 409 дээр монгол мессеж ба «Шинэчлэх»; дарахад шинэ утгыг татаж маягтыг дахин ачаалж, дараагийн хадгалалт шинэ updatedAt-ийг илгээнэ', async ({ page }) => {
  const { api, guard } = await setup(page);
  // Өөр tab нэрийг засчихсан: сервер OTHER_AT-тай, маягт LOADED_AT-тай
  serverWithCurrent(api, { at: OTHER_AT });
  api.get('/blacklist/:id', { json: entry({ name: 'A-гийн нэр', updatedAt: OTHER_AT }) });

  await openEdit(page);
  await nameField(page).fill('B-гийн нэр');
  await save(page);

  await expect(dialog(page).getByRole('alert').filter({ hasText: STALE_TEXT })).toBeVisible();
  await expect(refresh(page)).toBeVisible();
  await expect(refresh(page)).toHaveText('Шинэчлэх');
  await expect(dialog(page)).toBeVisible(); // маягт хаагдахгүй, оруулсан утга чимээгүй дарагдаагүй
  expect(api.lastCall('PATCH', '/blacklist/:id')?.body).toMatchObject({ name: 'B-гийн нэр', expectedUpdatedAt: LOADED_AT });
  expect(api.callsTo('GET', '/blacklist/:id')).toHaveLength(0);

  await refresh(page).click();
  await expect(nameField(page)).toHaveValue('A-гийн нэр');
  await expect(dialog(page).getByText(STALE_TEXT)).toHaveCount(0);
  expect(api.callsTo('GET', '/blacklist/:id')).toHaveLength(1);

  await nameField(page).fill('A-гийн нэр (дахин засав)');
  await save(page);
  await expect(toast(page)).toHaveText('Хадгаллаа');
  expect(api.callsTo('PATCH', '/blacklist/:id')).toHaveLength(2);
  expect(api.lastCall('PATCH', '/blacklist/:id')?.body).toMatchObject({ name: 'A-гийн нэр (дахин засав)', expectedUpdatedAt: OTHER_AT });
  expect(api.unhandled).toEqual([]);
  expect(guard.problems).toEqual([]);
});

test('F8-9: хуучин сервер updatedAt өгөөгүй бол expectedUpdatedAt илгээхгүй (backwards compatible)', async ({ page }) => {
  const { api } = await setup(page, entry({ updatedAt: undefined }));
  serverWithCurrent(api, { at: LOADED_AT });

  await openEdit(page);
  await nameField(page).fill('Шинэ нэр');
  await save(page);

  await expect(toast(page)).toHaveText('Хадгаллаа');
  const body = api.lastCall('PATCH', '/blacklist/:id')?.body as Record<string, unknown>;
  expect(body).toMatchObject({ name: 'Шинэ нэр' });
  expect(body).not.toHaveProperty('expectedUpdatedAt');
});

test('F8-9: «Шинэчлэх» амжилтгүй (бичлэг устсан) бол энгийн алдаа харуулж, «Шинэчлэх»-ийг давтуулахгүй; маягт нээлттэй', async ({ page }) => {
  const { api } = await setup(page);
  serverWithCurrent(api, { at: OTHER_AT });
  api.get('/blacklist/:id', { status: 404, json: { code: 'NOT_FOUND', message: 'Blacklist entry not found' } });

  await openEdit(page);
  await nameField(page).fill('B-гийн нэр');
  await save(page);
  await expect(refresh(page)).toBeVisible();

  await refresh(page).click();
  await expect(refresh(page)).toHaveCount(0);
  await expect(dialog(page).getByText(STALE_TEXT)).toHaveCount(0);
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(dialog(page)).toBeVisible();
});
