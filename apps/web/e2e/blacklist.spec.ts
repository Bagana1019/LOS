import { expect, test } from '@playwright/test';
import { guardConsole, MockApi } from './mock-api';

// FR-13.1: «Хар жагсаалт» — дээд түвшний цэс (Тохиргооны дээр). Жагсаалт, хайлт, нэмэх (хар/саарал), идэвхгүй болгох.

const entry = (over: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555551', orgId: 'org', registerNo: 'УБ12345678', customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT', severity: 'BLACK',
  reasonCode: 'OVERDUE_90', reasonText: 'Шүүхийн шийдвэр №12', source: 'COURT', validUntil: null, deactivationReason: null, pendingSeverity: null, isActive: true, registeredBy: 'u1', registeredAt: '2026-11-03T00:00:00.000Z', ...over,
});

test('цэс: Хар жагсаалт нь Тохиргооны яг дээр, дээд түвшинд; ADMIN нэмж, идэвхгүй болгоно', async ({ page }) => {
  const api = new MockApi('ADMIN');
  await api.install(page);
  const guard = guardConsole(page);
  const rows = [entry(), entry({ id: '55555555-5555-4555-8555-555555555552', registerNo: 'УБ99999999', name: 'Саарал Сараа', severity: 'GREY', reasonCode: 'SUSPICION', listType: 'WATCH' })];
  api.get('/blacklist', { json: { total: rows.length, items: rows } });
  api.post('/blacklist', ({ body }) => ({ status: 201, json: entry({ ...(body as object), id: '55555555-5555-4555-8555-555555555553' }) }));
  api.on('POST', '/blacklist/:id/deactivate', ({ params }) => ({ json: entry({ id: params.id, isActive: false }) }));
  api.get('/audit-logs', { json: { items: [{ id: 'a1', entity: 'blacklist', entityId: rows[0]!.id, action: 'CREATE', actorId: 'u1', at: '2026-11-03T01:00:00.000Z', applicationId: null, correlationId: null, beforeJson: null, afterJson: {} }], total: 1, page: 1, pageSize: 50 } });

  await page.goto('/');
  const items = page.locator('.ant-menu-item');
  const labels = await items.allInnerTexts();
  const bl = labels.findIndex((l) => l.includes('Хар жагсаалт'));
  const st = labels.findIndex((l) => l.includes('Тохиргоо'));
  expect(bl).toBeGreaterThanOrEqual(0);
  expect(bl).toBe(st - 1);

  await page.getByRole('menuitem', { name: /Хар жагсаалт/ }).click();
  await expect(page).toHaveURL('/los/blacklist');
  await expect(page.getByText('УБ12345678')).toBeVisible();
  await expect(page.getByText('Саарал Сараа')).toBeVisible();
  await page.screenshot({ path: process.env.BL_SHOT ?? '/tmp/blacklist-list.png', fullPage: true });

  await page.getByTestId('add-blacklist').click();
  await page.getByLabel('Регистрийн дугаар').fill('уб 11112222');
  await page.getByLabel('Нэр', { exact: true }).fill('Шинэ Этгээд');
  await page.getByText('Саарал', { exact: true }).last().click();
  await page.getByLabel('Шалтгаан', { exact: true }).click();
  await page.getByTitle('Сэжигтэй үйл ажиллагаа').click();
  await page.getByRole('button', { name: 'Хадгалах' }).click();
  await expect.poll(() => api.lastCall('POST', '/blacklist')?.body).toMatchObject({ registerNo: 'УБ11112222', severity: 'GREY', reasonCode: 'SUSPICION', customerType: 'INDIVIDUAL' });

  await page.getByRole('button', { name: 'Идэвхгүй болгох' }).first().click();
  await page.getByTestId('deactivation-reason').fill('Төлбөр барагдсан');
  await page.getByRole('button', { name: 'Идэвхгүй болгох' }).last().click();
  await expect.poll(() => api.callsTo('POST', '/blacklist/:id/deactivate').length).toBe(1);

  await page.getByRole('button', { name: 'Түүх' }).first().click();
  await expect(page.getByText('Нэмсэн')).toBeVisible();
  expect(api.unhandled).toEqual([]);
  expect(guard.problems).toEqual([]);
});

test('OFFICER: зөвхөн харах — нэмэх товч байхгүй, регистр далдлагдсан; хуучин хаяг шинэ рүү шилжинэ', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  api.get('/blacklist', { json: { total: 1, items: [entry()] } });
  await page.goto('/los/loan-application/blacklist');
  await expect(page).toHaveURL('/los/blacklist');
  await expect(page.getByTestId('bl-register')).toHaveText('УБ••••5678');
  await expect(page.getByTestId('add-blacklist')).toHaveCount(0);
  await expect(page.getByText('Та зөвхөн харах эрхтэй')).toBeVisible();
});
