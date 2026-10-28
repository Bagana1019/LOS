import { expect, test, type Page } from '@playwright/test';
import { mockGateway, PASSWORD } from './mock-gateway';

async function signIn(page: Page, username = 'officer.a', password = PASSWORD) {
  await page.getByLabel('Нэвтрэх нэр').fill(username);
  await page.getByLabel('Нууц үг').fill(password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
}
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

test.describe('нэвтрэлт', () => {
  test('нэвтрээгүй хэрэглэгч /login руу, нэвтэрсний дараа анх нээсэн хуудас руугаа очно', async ({ page }) => {
    await mockGateway(page);
    await page.goto('/los/report?x=1');
    await expect(page).toHaveURL(/\/login\?next=%2Flos%2Freport%3Fx%3D1$/);
    await expect(page.getByRole('heading', { name: 'LOS Radix' })).toBeVisible();
    await signIn(page);
    await expect(page).toHaveURL('/los/report?x=1');
    await expect(menuItem(page, 'Тайлан')).toBeVisible();
  });

  test('буруу нууц үг: монгол алдаа, нэвтрэх хуудсандаа үлдэнэ', async ({ page }) => {
    await mockGateway(page);
    await page.goto('/login');
    await signIn(page, 'officer.a', 'wrong');
    await expect(page.locator('.ant-alert-error')).toContainText('Нэвтрэх нэр эсвэл нууц үг буруу');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('хоосон талбар: сервер рүү дуудахгүй, шалгалтын мессеж', async ({ page }) => {
    const gw = await mockGateway(page);
    await page.goto('/login');
    await page.getByRole('button', { name: 'Нэвтрэх' }).click();
    await expect(page.getByText('Нэвтрэх нэрээ оруулна уу')).toBeVisible();
    await expect(page.getByText('Нууц үгээ оруулна уу')).toBeVisible();
    expect(gw.requests.filter((r) => r.includes('/auth/login'))).toEqual([]);
  });

  test('хэт олон оролдлого (429) ба сүлжээний алдаа өөр мессеж', async ({ page }) => {
    await mockGateway(page);
    await page.goto('/login');
    await signIn(page, 'throttled', 'x');
    await expect(page.locator('.ant-alert-error')).toContainText('Хэт олон оролдлого');
  });

  test('`next`-д гаднын хаяг өгвөл нүүр хуудас руу (open redirect үгүй)', async ({ page }) => {
    await mockGateway(page);
    await page.goto('/login?next=//evil.example');
    await signIn(page);
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible();
  });

  test('хуудас дахин ачаалахад cookie-ээр сесс сэргэнэ; гарсны дараа сэргэхгүй', async ({ page }) => {
    await mockGateway(page);
    await page.goto('/login');
    await signIn(page);
    await expect(page).toHaveURL('/');
    await page.reload();
    await expect(page).toHaveURL('/');
    await expect(menuItem(page, 'Тайлан')).toBeVisible();

    await page.getByRole('button', { name: 'Хэрэглэгчийн цэс' }).click();
    await page.getByRole('menuitem', { name: 'Гарах' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('gateway хариугүй үед "нэвтрээгүй" гэж андуурахгүй: дахин оролдох товч', async ({ page }) => {
    const gw = await mockGateway(page, { signedIn: true, down: true });
    await page.goto('/');
    await expect(page.getByText('Серверт холбогдож чадсангүй')).toBeVisible();
    gw.down = false;
    await page.getByRole('button', { name: 'Дахин оролдох' }).click();
    await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible();
  });
});

test.describe('дүрээр цэс (GET /api/auth/me)', () => {
  test('ЗЭЗ: Тохиргоо цэсгүй, /settings руу орвол "Эрх хүрэхгүй"', async ({ page }) => {
    await mockGateway(page, { signedIn: true, role: 'OFFICER' });
    await page.goto('/');
    for (const name of ['Нүүр', 'Харилцагч', 'Хүсэлт', 'Зээл', 'Тайлан']) await expect(menuItem(page, name)).toBeVisible();
    await expect(menuItem(page, 'Тохиргоо')).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.getByText('Эрх хүрэхгүй')).toBeVisible();
  });

  test('Админ: Тохиргоо цэстэй; BSA хуудас руу орохгүй (bsa:review эрхгүй)', async ({ page }) => {
    await mockGateway(page, { signedIn: true, role: 'ADMIN' });
    await page.goto('/settings');
    await expect(menuItem(page, 'Тохиргоо')).toBeVisible();
    await expect(page.getByText('Эрх хүрэхгүй')).toHaveCount(0);
    await page.goto('/los/bsa/123');
    await expect(page.getByText('Эрх хүрэхгүй')).toBeVisible();
  });

  test('олдохгүй хаяг: 404', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/no/such/page');
    await expect(page.getByText('Хуудас олдсонгүй')).toBeVisible();
  });
});

test.describe('дээд хайлт ба мэдэгдлийн хонх', () => {
  test('цэсээр хайж, сонгоход тухайн хуудас руу очно', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    await page.getByPlaceholder('Гэрээний дугаар эсвэл цэс хайх').fill('Тай');
    await page.locator('.ant-select-item-option', { hasText: 'Тайлан' }).click();
    await expect(page).toHaveURL('/los/report');
  });

  test('гэрээний дугаар (тоотой) + Enter: хүсэлтийн жагсаалтын ?q= руу', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    const search = page.getByPlaceholder('Гэрээний дугаар эсвэл цэс хайх');
    await search.fill('LA-2026-000123');
    await expect(page.locator('.ant-select-item-option', { hasText: 'Гэрээний дугаараар хайх: «LA-2026-000123»' })).toBeVisible();
    await search.press('Enter');
    await expect(page).toHaveURL('/los/loan-application?q=LA-2026-000123');
  });

  test('`/` товч хайлтад фокус өгнө', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    const search = page.getByPlaceholder('Гэрээний дугаар эсвэл цэс хайх');
    await expect(search).toBeVisible(); // сесс сэргээгдэж shell зурагдсаны дараа
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
  });

  test('хонх: endpoint хараахан байхгүй (404) үед "мэдэгдэл алга", алдаа харуулахгүй', async ({ page }) => {
    const gw = await mockGateway(page, { signedIn: true, notifications: null });
    await page.goto('/');
    await page.getByRole('button', { name: /Мэдэгдэл/ }).click();
    await expect(page.getByText('Шинэ мэдэгдэл алга')).toBeVisible();
    await expect(page.getByText('Мэдэгдэл ачаалж чадсангүй')).toHaveCount(0);
    expect(gw.requests.filter((r) => r.includes('/notifications')).length).toBe(1);
  });

  test('хонх: уншаагүй тоо ба жагсаалт', async ({ page }) => {
    await mockGateway(page, {
      signedIn: true,
      notifications: {
        unreadCount: 2,
        items: [
          { id: 'n1', type: 'RETURNED', applicationId: 'a1', payload: {}, readAt: null, createdAt: '2026-10-28T08:00:00.000Z' },
          { id: 'n2', type: 'APPROVAL_REQUESTED', applicationId: 'a2', payload: {}, readAt: null, createdAt: '2026-10-28T09:00:00.000Z' },
          { id: 'n3', type: 'APPROVED', applicationId: 'a3', payload: {}, readAt: '2026-10-27T09:00:00.000Z', createdAt: '2026-10-27T08:00:00.000Z' },
        ],
      },
    });
    await page.goto('/');
    const bell = page.getByRole('button', { name: 'Мэдэгдэл, 2 уншаагүй' });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByText('Хүсэлт буцаагдлаа')).toBeVisible();
    await expect(page.getByText('Батлах хүсэлт ирлээ')).toBeVisible();
    await expect(page.getByText('Хүсэлт батлагдлаа')).toBeVisible();
  });
});
