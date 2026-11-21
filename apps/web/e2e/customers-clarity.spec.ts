import { expect, test, type Page } from '@playwright/test';
import { guardConsole, MockApi } from './mock-api';

// Chrome naive-user findings F1-1, F1-5, F1-7, F1-8, F1-12 (харилцагчийн маягтын тал): ойлгомжгүй текст / чимээгүй татгалзлыг тодорхой болгоно. gateway mock-той.
const REGISTER = 'УБ90010112';
const EMPTY_LIST = { items: [], total: 0, page: 1, pageSize: 20 };

/** /customer/new → регистр → иргэний кодын алхам (ХУР mock). */
async function toOtpStep(page: Page, api: MockApi) {
  api.on('POST', '/customers/xyp-otp', { json: { sent: true, requestedAt: new Date().toISOString(), existing: null, warnings: [] } });
  await page.goto('/customer/new');
  await page.getByTestId('customer-register').fill(REGISTER);
  await page.getByTestId('customer-check').click();
  await expect(page.getByTestId('xyp-otp-step')).toBeVisible();
}

/** Кодын алхмаас «Гараар бөглөх» → бүтэн маягт. */
async function toManualForm(page: Page, api: MockApi) {
  await toOtpStep(page, api);
  await page.getByTestId('xyp-otp-manual').click();
  await expect(page.getByTestId('customer-submit')).toBeVisible();
}

test('F1-1: хайлтын placeholder бүтэн регистрийг заана; хэсэгчилсэн / Latin регистр хоосон үед тайлбар гарна, нэрийн хайлт дээр гарахгүй', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  const guard = guardConsole(page);
  api.on('GET', '/customers', { json: EMPTY_LIST });

  await page.goto('/customer');
  const search = page.getByPlaceholder('Бүтэн регистр (УБ99010112), нэр, утас');
  await expect(search).toBeVisible();

  await search.fill('уб');
  await search.press('Enter');
  await expect(page.getByTestId('customer-search-hint')).toContainText('бүтэн дугаараар');

  await search.fill('UB9901');
  await search.press('Enter');
  await expect(page.getByTestId('customer-search-hint')).toContainText('кирилл үсгээр');

  await search.fill('Бат');
  await search.press('Enter');
  await expect(page.getByTestId('customer-list-empty')).toContainText('Харилцагч олдсонгүй');
  await expect(page.getByTestId('customer-search-hint')).toHaveCount(0);
  expect(api.lastCall('GET', '/customers')?.search.get('q')).toBe('Бат');
  expect(guard.problems).toEqual([]);
});

test('F1-5: Latin үсгээр бичсэн регистр «буруу» биш, кирилл үсгээр бичихийг хэлнэ; бусад буруу утгад ерөнхий мессеж хэвээр', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  await page.goto('/customer/new');

  await page.getByTestId('customer-register').fill('UB90010112');
  await page.getByTestId('customer-check').click();
  await expect(page.getByText('Кирилл үсгээр бичнэ үү (UB → УБ)')).toBeVisible();
  await expect(page.getByText('Регистрийн дугаар буруу')).toHaveCount(0);

  await page.getByTestId('customer-register').fill('УБ9001');
  await page.getByTestId('customer-check').click();
  await expect(page.getByText('Регистрийн дугаар буруу')).toBeVisible();
  await expect(page.getByText('Кирилл үсгээр бичнэ үү (UB → УБ)')).toHaveCount(0);
  expect(api.callsTo('POST', '/customers/xyp-otp')).toHaveLength(0); // буруу регистрээр ХУР руу код хүсэхгүй
});

test('F1-7: буруу код = дахин оролдох боломжтой тодорхой мессеж; оролдлого дуусвал баталгаажуулах идэвхгүй, гараар бөглөх гарц үлдэнэ', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  let fetches = 0;
  api.on('POST', '/customers/xyp-fetch', () => {
    fetches += 1;
    return fetches === 1
      ? { status: 422, json: { code: 'XYP_OTP_INVALID', message: 'bad code' } }
      : { status: 429, json: { code: 'XYP_OTP_ATTEMPTS_EXHAUSTED', message: 'no attempts left' } };
  });
  await toOtpStep(page, api);
  const input = page.getByTestId('xyp-otp-input');
  const submit = page.getByTestId('xyp-otp-submit');
  const error = page.getByTestId('xyp-otp-error');

  await input.fill('111111');
  await submit.click();
  await expect(error).toContainText('Иргэний код буруу байна');
  await expect(error).not.toContainText('хүлээн авсангүй'); // өмнөх «шинэ код авна уу» гэсэн нэг мессеж биш
  await expect(input).toBeEnabled();
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(error).toContainText('оролдох эрх дууслаа');
  await expect(input).toBeDisabled();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId('xyp-otp-manual')).toBeEnabled();
  expect(fetches).toBe(2);
});

test('F1-8: хүйсийн placeholder «Хүйс сонгоно уу» (2-р биш); регистрээс автоматаар бөглөхгүй (Q-074)', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  await toManualForm(page, api);

  await expect(page.locator('.ant-select-selection-placeholder', { hasText: /^Хүйс сонгоно уу$/ })).toBeVisible();
  await expect(page.getByText('Хүйсээ сонгоно уу')).toHaveCount(0);
});

test('F1-12 (харилцагчийн маягт): .exe ба 0 байтын файл мессежтэй татгалзагдана; зөв файлын нэр харагдаж, устгаж болно', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  api.post('/dms/files', { status: 201, json: { id: '33333333-3333-4333-8333-333333333333', name: 'id.png', mime: 'image/png', size: 1 } });
  await toManualForm(page, api);
  const pick = (name: string, mimeType: string, buffer: Buffer) => page.setInputFiles('input[type=file]', { name, mimeType, buffer });

  await pick('run.exe', 'application/octet-stream', Buffer.from('MZ'));
  await expect(page.locator('.ant-message-notice').filter({ hasText: 'run.exe' })).toBeVisible();
  await expect(page.getByTestId('customer-photo-error')).toContainText('PNG, JPG, JPEG эсвэл PDF');

  await pick('empty.png', 'image/png', Buffer.alloc(0));
  await expect(page.getByTestId('customer-photo-error')).toContainText('хоосон');
  expect(api.callsTo('POST', '/dms/files')).toHaveLength(0); // татгалзсан файл сервер рүү явахгүй

  await pick('id.png', 'image/png', Buffer.from('x'));
  await expect(page.getByTestId('customer-photo-name')).toHaveText('id.png');
  await expect(page.getByTestId('customer-photo-error')).toHaveCount(0);
  expect(api.callsTo('POST', '/dms/files')).toHaveLength(1);

  await page.getByTestId('customer-photo-remove').click();
  await expect(page.getByTestId('customer-photo-name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Зураг оруулах' })).toBeVisible();
});
