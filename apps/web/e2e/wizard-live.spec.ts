import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

// Бодит stack дээр нэг хүсэлтийг wizard-аар олголт хүртэл дамжуулна (docs/LOCAL-SETUP.md §5.1).
// Урьдчилсан нөхцөл: шинэ өгөгдлийн сан + `SEED_DEMO=1 pnpm --filter @los/origination db:seed` (DEMO-COL-0001), `E2E_LIVE=1`.
// Хүсэлтийн төлөв нэг чиглэлтэй (олголтоор дуусна) тул тестийг дахин ажиллуулахын өмнө `node scripts/local-setup.mjs reset`.
const LIVE = process.env.E2E_LIVE === '1';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Los@2026!dev';
const APP = '00000000-0000-4000-8000-000000000402';
const API = 'http://localhost:4000/api';
const SCAN = join(__dirname, 'fixtures-scan.pdf');

async function signIn(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel('Нэвтрэх нэр').fill(username);
  await page.getByLabel('Нууц үг').fill(PASSWORD);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible();
}
const step = (page: Page, key: string) => page.goto(`/los/loan-application/${APP}/${key}`);
const confirm = (page: Page) => page.locator('.ant-modal-confirm .ant-btn-primary').click();

test.describe('wizard: хүсэлт → олголт (бодит stack)', () => {
  test.skip(!LIVE, 'E2E_LIVE=1 шаардлагатай');
  test.describe.configure({ mode: 'serial' });

  test('ЗЭЗ: нөхцөл, орлого, ЭТХ, тооцоолол, баримт, илгээх', async ({ page, request }) => {
    test.setTimeout(180_000);
    // DEMO гэрээний загвар (Тохиргоо → Загвар-ын UI байхгүй тул админаар API-аар)
    const login = await request.post(`${API}/auth/login`, { data: { username: 'admin', password: PASSWORD } });
    const { accessToken } = (await login.json()) as { accessToken: string };
    expect((await request.post(`${API}/dms/templates/demo`, { headers: { authorization: `Bearer ${accessToken}` } })).ok()).toBeTruthy();

    await signIn(page, 'officer.a');
    // 4 · зээлийн нөхцөл: барьцаагүй бүтээгдэхүүн рүү шилжүүлж зориулалт бичнэ
    await step(page, 'loan');
    await page.getByTestId('terms-product').click();
    await page.locator('.ant-select-item-option', { hasText: 'Хэрэглээний зээл' }).click();
    await page.getByTestId('terms-purpose').fill('Хэрэглээний хэрэгцээ');
    await page.getByTestId('terms-save').click();
    await expect(page.getByText('Зээлийн нөхцөл хадгалагдлаа')).toBeVisible();
    // 5 · барьцаа: бүтээгдэхүүн солигдсон тул G0-г дахин тооцно (барьцаа шаардахгүй → алгасна)
    await step(page, 'collateral');
    await page.getByRole('button', { name: 'G0 дахин тооцох' }).click();
    // 3 · орлого: НДШ-ээс татаж 12 сарын дундаж
    await step(page, 'income');
    await page.getByRole('button', { name: 'НДШ-ээс татах' }).click();
    await expect(page.getByText('Төв аймгийн ЗДТГ').first()).toBeVisible();
    await page.getByPlaceholder('Эхлэх сар').fill('2025-11');
    await page.keyboard.press('Enter');
    await page.getByPlaceholder('Дуусах сар').fill('2026-10');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Тооцоолох' }).first().click();
    await expect(page.getByText('Алхам бүрдсэн')).toBeVisible();
    // 6 · ЭТХ
    await step(page, 'installment');
    await page.getByTestId('sched-preview').click();
    await expect(page.getByTestId('sched-table')).toBeVisible();
    await page.getByTestId('sched-save').click();
    await expect(page.getByText('Хуваарь хадгалагдлаа')).toBeVisible();
    // 7 · тооцоолол
    await step(page, 'score');
    await page.getByRole('button', { name: 'Тооцоолох (хадгалах)' }).click();
    await expect(page.getByText(/Хадгалсан ·/)).toBeVisible();
    // 8 · баримт (3 заавал)
    await step(page, 'document');
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Файл хавсаргах' }).first().click();
      await page.locator('.ant-modal input[type=file]').setInputFiles(SCAN);
      const select = page.locator('.ant-modal .ant-select');
      if (await select.count()) { await select.first().click(); await page.locator('.ant-select-item-option').first().click(); }
      await page.locator('.ant-modal .ant-btn-primary').click();
      await expect(page.locator('.ant-modal')).toBeHidden(); // хавсарсны дараа цонх хаагдана
    }
    // 9 · илгээх
    await step(page, 'decision');
    await page.getByTestId('submit-application').click();
    await confirm(page);
    await expect(page.getByTestId('app-status')).toHaveText('Батлах явцад');
  });

  test('батлагчид: 2 түвшин санал өгч батлана', async ({ page }) => {
    test.setTimeout(120_000);
    for (const user of ['manager', 'approver']) {
      await page.context().clearCookies();
      await signIn(page, user);
      await step(page, 'decision');
      await page.getByTestId('vote-approve').click();
      await confirm(page);
      await expect(page.getByText('Санал бүртгэгдлээ: батлав')).toBeVisible();
    }
    await expect(page.getByTestId('app-status')).toHaveText('Батлагдсан');
  });

  test('ЗЭЗ: гэрээ, албан бичиг, олголтын хүсэлт; батлагч олгоно', async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page, 'officer.a');
    await step(page, 'contract');
    await page.getByTestId('contract-generate').click();
    await expect(page.getByRole('button', { name: 'Татах (PDF)' })).toBeVisible({ timeout: 30_000 });
    await page.locator('input[type=file]').first().setInputFiles(SCAN); // цаасан гарын үсэг (G4)
    await expect(page.getByText('Гарын үсэг зурагдсан')).toBeVisible({ timeout: 30_000 });
    await step(page, 'official_documents');
    await page.getByTestId('letter-create').click();
    await expect(page.getByText('Хэвлээгүй')).toBeVisible({ timeout: 30_000 });
    await step(page, 'disburse');
    await page.getByTestId('disb-bank').fill('KHAN');
    await page.getByTestId('disb-account').fill('5012345678');
    await page.getByTestId('disb-holder').fill('Номин Дашдорж'); // kyc mock-ийн ХУР-ын нэр
    await page.getByTestId('disb-save').click();
    await expect(page.getByTestId('disb-submit')).toBeEnabled();
    await page.getByTestId('disb-submit').click();
    await confirm(page);
    await expect(page.getByTestId('disb-status')).toHaveText('Илгээсэн');

    await page.context().clearCookies();
    await signIn(page, 'approver');
    await step(page, 'disburse');
    await page.getByTestId('disb-approve').click();
    await confirm(page);
    await expect(page.getByTestId('disb-status')).toHaveText('Core-д олгосон');
  });
});
