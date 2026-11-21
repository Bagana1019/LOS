import { expect, test } from '@playwright/test';
import { OrgDirectory, type AuditActorOption, type AuditLogPage } from '@los/contracts';
import { expectClean, setupBackOffice } from './helpers';
import type { MockApi, MockRequest } from './mock-api';

// F9-24 · /settings/audit: шүүлтүүр өмнө нь яг таарах + том/жижиг үсэгт мэдрэмтгий, "Хэрэглэгч" нь UUID шаарддаг, "Хэн" багана түүхий UUID байв.
// Одоо: объект/үйлдэл API-ийн бодит утгаас санал болгоно (том/жижиг үсэг үл ялгаж хэсэгчлэн шүүнэ), хэрэглэгчийг нэр/нэвтрэх нэрээр сонгоно, "Хэн" = нэр.
const ADMIN_ID = '00000000-0000-4000-8000-000000000205';
const OFFICER_ID = '00000000-0000-4000-8000-000000000201';
const GHOST_ID = '00000000-0000-4000-8000-0000000009c1';
const PASTED_ID = '11111111-1111-4111-8111-111111111111';
const TABLE_PAGE_SIZE = '25';
const SAMPLE_PAGE_SIZE = '200';

type Row = AuditLogPage['items'][number];
const row = (id: string, entity: string, action: string, actorId: string | null): Row => ({
  id, entity, entityId: `e-${id}`, action, actorId, at: '2026-11-20T09:00:00.000Z', applicationId: null, correlationId: null, beforeJson: null, afterJson: null,
});
const ROWS = [
  row('r1', 'SETTING', 'SETTING_UPDATED', ADMIN_ID),
  row('r2', 'blacklist', 'CREATE', OFFICER_ID),
  row('r3', 'CUSTOMER', 'CUSTOMER_CREATED', GHOST_ID),
  row('r4', 'LOAN_APPLICATION', 'STATUS_CHANGED', null),
];
const PAGE: AuditLogPage = { items: ROWS, total: ROWS.length, page: 1, pageSize: 25 };
const ACTORS: AuditActorOption[] = [{ id: ADMIN_ID, username: 'admin', fullName: 'Админ' }, { id: OFFICER_ID, username: 'officer.a', fullName: 'ЗЭЗ А' }];

/** Бодит API-ийн адил `actorId`-аар шүүнэ: react-query cache (staleTime 30с) цэвэрлэсний дараа шинэ дуудлага гаргахгүй тул ажиглах зүйл нь хүснэгтийн мөр. */
const listReply = ({ search }: MockRequest) => {
  const actorId = search.get('actorId');
  const items = actorId ? ROWS.filter((r) => r.actorId === actorId) : ROWS;
  return { json: { ...PAGE, items, total: items.length } };
};

function install(api: MockApi) {
  api.get('/audit-logs', listReply);
  api.get('/admin/audit-logs', listReply);
  api.get('/directory', { json: OrgDirectory.parse({ branches: {}, users: { [ADMIN_ID]: 'Админ', [OFFICER_ID]: 'ЗЭЗ А' } }) });
  api.get('/admin/audit-actors', ({ search }) => {
    const q = (search.get('q') ?? '').toLowerCase();
    return { json: ACTORS.filter((a) => `${a.fullName} ${a.username}`.toLowerCase().includes(q)) };
  });
}

/** Хүснэгтийн (25 мөр) хүсэлтүүд; сонголтын жишээ авалт (200 мөр) орохгүй. */
const tableCalls = (api: MockApi, path: string) => api.callsTo('GET', path).filter((c) => c.search.get('pageSize') === TABLE_PAGE_SIZE);
const lastTableParam = (api: MockApi, path: string, name: string) => tableCalls(api, path).at(-1)?.search.get(name) ?? null;

test.describe('Аудит лог · шүүлтүүр (F9-24)', () => {
  test('"Хэн" баганад ажилтны нэр; лавлахад олдохгүй бол id; actorId-гүй бол "—"', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    install(api);
    await page.goto('/settings/audit');
    const table = page.getByRole('table');
    await expect(table).toContainText('SETTING_UPDATED');
    await expect(table.locator('tr', { hasText: 'SETTING_UPDATED' })).toContainText('Админ');
    await expect(table.locator('tr', { hasText: 'CREATE' }).first()).toContainText('ЗЭЗ А');
    await expect(table.locator('tr', { hasText: 'CUSTOMER_CREATED' })).toContainText(GHOST_ID);
    await expect(table).not.toContainText(ADMIN_ID);
    await expect(table.locator('tr', { hasText: 'STATUS_CHANGED' })).toContainText('—');
    expectClean(guard, api);
  });

  test('Объект: API-ийн бодит утгаас санал болгоно, том/жижиг үсэг үл ялгаж хэсэгчлэн шүүнэ, сонгоход яг утгыг илгээнэ', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    install(api);
    await page.goto('/settings/audit');
    await expect(page.getByRole('table')).toContainText('SETTING_UPDATED');
    expect(api.callsTo('GET', '/audit-logs').some((c) => c.search.get('pageSize') === SAMPLE_PAGE_SIZE && !c.search.get('entity')), 'unfiltered sample request').toBe(true);

    const entity = page.getByRole('combobox', { name: 'Объект' });
    await entity.fill('sett');
    const options = page.locator('.ant-select-item-option');
    await expect(options).toHaveText(['SETTING']);
    await options.first().click();
    await expect.poll(() => lastTableParam(api, '/audit-logs', 'entity')).toBe('SETTING');

    await entity.fill('zzz');
    await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')).toHaveCount(0);
    expectClean(guard, api);
  });

  test('Үйлдэл: санал болгох жагсаалт; "created" → *_CREATED; Нэвтрэлт таб чөлөөт бичвэрийг (зайгүй) серверт дамжуулна', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    install(api);
    await page.goto('/settings/audit');
    const action = page.getByRole('combobox', { name: 'Үйлдэл' });
    await action.fill('created');
    await expect(page.locator('.ant-select-item-option')).toHaveText(['CUSTOMER_CREATED']);

    await page.locator('.ant-segmented-item', { hasText: 'Нэвтрэлт, хэрэглэгч' }).click();
    await action.fill('  created ');
    await expect.poll(() => lastTableParam(api, '/admin/audit-logs', 'action')).toBe('created');
    expectClean(guard, api);
  });

  test('Хэн: нэр/нэвтрэх нэрээр хайж сонгоно → actorId (UUID) илгээнэ; нэр харагдана; цэвэрлэвэл шүүлт арилна', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    install(api);
    await page.goto('/settings/audit');
    const actor = page.getByRole('combobox', { name: 'Хэрэглэгч' });
    await actor.fill('адм');
    await expect.poll(() => api.lastCall('GET', '/admin/audit-actors')?.search.get('q')).toBe('адм');
    await page.locator('.ant-select-item-option', { hasText: 'Админ (admin)' }).click();
    await expect.poll(() => lastTableParam(api, '/audit-logs', 'actorId')).toBe(ADMIN_ID);
    const table = page.getByRole('table');
    await expect(table).toContainText('SETTING_UPDATED');
    await expect(table).not.toContainText('CUSTOMER_CREATED');
    const chosen = page.locator('.ant-select-selection-item', { hasText: 'Админ (admin)' });
    await expect(chosen).toBeVisible();
    await expect(chosen).not.toContainText(ADMIN_ID);

    await chosen.hover();
    await page.locator('.ant-select-clear').click();
    await expect(table).toContainText('CUSTOMER_CREATED'); // шүүлт арилж бүх мөр буцна
    await expect(page.locator('.ant-select-selection-item')).toHaveCount(0);
    expectClean(guard, api);
  });

  test('Хэн: буулгасан UUID-ийг сонгож болно (id-аар шүүх хуучин боломж хадгалагдана)', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    install(api);
    await page.goto('/settings/audit');
    await page.getByRole('combobox', { name: 'Хэрэглэгч' }).fill(PASTED_ID);
    await page.locator('.ant-select-item-option', { hasText: PASTED_ID }).click();
    await expect.poll(() => lastTableParam(api, '/audit-logs', 'actorId')).toBe(PASTED_ID);
    expectClean(guard, api);
  });

  test('Хэн: хайлтын дуудлага алдаатай үед хуудас ажиллана, "Ачаалж чадсангүй" гэж хэлнэ', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    install(api);
    api.get('/admin/audit-actors', { status: 500, json: { code: 'INTERNAL', message: 'x' } });
    await page.goto('/settings/audit');
    await page.getByRole('combobox', { name: 'Хэрэглэгч' }).fill('адм');
    await expect(page.locator('.ant-select-dropdown')).toContainText('Ачаалж чадсангүй');
    await expect(page.getByRole('table')).toContainText('SETTING_UPDATED');
    expectClean(guard, api);
  });
});
