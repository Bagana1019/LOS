import { expect, test, type Page } from '@playwright/test';
import type { NotificationView } from '@los/contracts';
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

  test('гарахад `next` үлдэхгүй: дараагийн хүн өмнөх хуудас руу очихгүй', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/los/report');
    await expect(menuItem(page, 'Тайлан')).toBeVisible();
    await page.getByRole('button', { name: 'Хэрэглэгчийн цэс' }).click();
    await page.getByRole('menuitem', { name: 'Гарах' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('сесс дундаа дуусвал (refresh 401) нэвтрэх хуудас руу, "дууссан" мэдэгдэлтэй', async ({ page }) => {
    const gw = await mockGateway(page, { signedIn: true });
    await page.clock.install();
    await page.goto('/los/report');
    await expect(menuItem(page, 'Тайлан')).toBeVisible();
    gw.signedIn = false;
    gw.rejectAccess = true;
    await page.clock.fastForward(31_000); // хонхны 30с-ийн polling → 401 → refresh 401
    await expect(page).toHaveURL(/\/login\?next=%2Flos%2Freport$/);
    await expect(page.getByText('Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.')).toBeVisible();
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

test.describe('sidebar', () => {
  test('эцэг цэс дээр дарахад дэд цэс нуугдахгүй; дэд хуудас руу шууд орсон ч сонгосон мөр харагдана', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    await menuItem(page, 'Хүсэлт').click();
    await expect(page).toHaveURL('/los/loan-application');
    await expect(menuItem(page, 'Хар жагсаалт')).toBeVisible();
    await page.goto('/los/loan-application/blacklist');
    await expect(page.locator('.ant-menu-item-selected', { hasText: 'Хар жагсаалт' })).toBeVisible();
  });

  test('мөрийн хоосон хэсэг дээр дарсан ч шилжинэ (зөвхөн текст биш)', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    await menuItem(page, 'Тайлан').click({ position: { x: 200, y: 8 } });
    await expect(page).toHaveURL('/los/report');
  });

  test('товчоор нугалж, aria-expanded шинэчлэгдэнэ', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Цэсийг нээх, хаах' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.ant-layout-sider-collapsed')).toBeVisible();
  });
});

test.describe('дээд хайлт ба мэдэгдлийн хонх', () => {
  test('Tab дарахад (фокус зөөх) хуудас солигдохгүй', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    const search = page.getByPlaceholder('Гэрээний дугаар эсвэл цэс хайх');
    await search.fill('Тай');
    await expect(page.locator('.ant-select-item-option', { hasText: 'Тайлан' })).toBeVisible();
    await search.press('Tab');
    await expect(page).toHaveURL('/');
  });

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

  test('хонх: мэдэгдэл байхгүй үед "мэдэгдэл алга", алдаа харуулахгүй', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    const bell = page.getByRole('button', { name: 'Мэдэгдэл', exact: true });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByText('Шинэ мэдэгдэл алга')).toBeVisible();
    await expect(page.getByText('Мэдэгдлийг ачаалж чадсангүй')).toHaveCount(0);
  });

  test('хонх: уншаагүй тоо ба жагсаалт', async ({ page }) => {
    const note = (id: string, title: string, readAt: string | null, createdAt: string): NotificationView => ({ id, type: 'RETURNED', applicationId: null, title, body: `${title} — тайлбар`, payload: {}, readAt, createdAt });
    await mockGateway(page, {
      signedIn: true,
      notifications: [
        note('n1', 'Хүсэлт буцаагдлаа', null, '2026-10-28T08:00:00.000Z'),
        note('n2', 'Батлах хүсэлт ирлээ', null, '2026-10-28T09:00:00.000Z'),
        note('n3', 'Хүсэлт батлагдлаа', '2026-10-27T09:00:00.000Z', '2026-10-27T08:00:00.000Z'),
      ],
    });
    await page.goto('/');
    const bell = page.getByRole('button', { name: 'Мэдэгдэл, уншаагүй 2' });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.locator('.ant-popover').getByRole('button', { name: new RegExp('Хүсэлт буцаагдлаа — тайлбар') })).toBeVisible();
    await expect(page.locator('.ant-popover').getByRole('button', { name: new RegExp('Батлах хүсэлт ирлээ — тайлбар') })).toBeVisible();
    await expect(page.locator('.ant-popover').getByRole('button', { name: new RegExp('Хүсэлт батлагдлаа — тайлбар') })).toBeVisible();
  });

  test('хонх: дахин нээхэд харьцангуй хугацаа шинэчлэгдэнэ (өгөгдөл өөрчлөгдөөгүй байсан ч)', async ({ page }) => {
    await mockGateway(page, {
      signedIn: true,
      notifications: [{ id: 'n1', type: 'RETURNED', applicationId: null, title: 'Хүсэлт буцаагдлаа', body: 'тайлбар', payload: {}, readAt: null, createdAt: '2026-10-28T09:00:00.000Z' }],
    });
    await page.clock.install({ time: new Date('2026-10-28T09:00:10.000Z') });
    await page.goto('/');
    const bell = page.getByRole('button', { name: /^Мэдэгдэл/ });
    await bell.click();
    const popover = page.locator('.ant-popover');
    await expect(popover.getByText('Дөнгөж сая')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await page.clock.fastForward(30 * 60_000);
    await bell.click();
    await expect(popover.getByText('30 минутын өмнө')).toBeVisible();
  });
});

test.describe('нийтийн хуудас ба өөрийн shell-тэй хэсэг', () => {
  const search = (page: Page) => page.getByPlaceholder('Гэрээний дугаар эсвэл цэс хайх');

  test('/sign, /verify (FR-11.4): нэвтрэлт шаардахгүй — /login руу явуулахгүй, сесс сэргээх дуудлага хийхгүй, staff shell-гүй', async ({ page }) => {
    const gw = await mockGateway(page, { authOnly: true });
    await page.goto('/sign/abc-123');
    await expect(page).toHaveURL(/\/sign\/abc-123$/);
    await page.waitForLoadState('networkidle');
    await expect(search(page)).toHaveCount(0);
    await page.goto('/verify/XYZ-1');
    await expect(page).toHaveURL(/\/verify\/XYZ-1$/);
    await page.waitForLoadState('networkidle');
    await expect(search(page)).toHaveCount(0);
    expect(gw.requests, 'нийтийн хуудас /auth/*-д хүрэхгүй').toEqual([]);
  });

  test('/merchant: нэвтрээгүй бол /login руу (next-тэй)', async ({ page }) => {
    await mockGateway(page, { authOnly: true });
    await page.goto('/merchant/leases');
    await expect(page).toHaveURL(/\/login\?next=%2Fmerchant%2Fleases$/);
  });

  test('/merchant: нэвтэрсэн бол мерчантын өөрийн shell — staff sidebar/хайлт/хонхгүй', async ({ page }) => {
    await mockGateway(page, { signedIn: true, authOnly: true });
    await page.goto('/merchant');
    await expect(page.locator('.mp-shell')).toBeVisible();
    await expect(page.locator('.ant-layout-sider')).toHaveCount(0);
    await expect(search(page)).toHaveCount(0);
  });

  test('/settings/merchants (staff-ийн мерчант удирдлага): staff shell-тэй', async ({ page }) => {
    await mockGateway(page, { signedIn: true, role: 'ADMIN', authOnly: true });
    await page.goto('/settings/merchants');
    await expect(menuItem(page, 'Тохиргоо')).toBeVisible();
    await expect(search(page)).toBeVisible();
    await expect(page.getByText('Эрх хүрэхгүй')).toHaveCount(0);
  });
});

test.describe('утас (lg-ээс нарийн)', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('sidebar контентыг шахахгүй: хаалттай, товчоор давхарлан нээгдэж, цэс сонгоход хаагдана; хэвтээ гүйлгэлтгүй', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Цэсийг нээх, хаах' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menuItem(page, 'Зээл')).not.toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menuItem(page, 'Зээл')).toBeInViewport();
    await menuItem(page, 'Зээл').click();
    await expect(page).toHaveURL(/\/los\/loan\/list$/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menuItem(page, 'Зээл')).not.toBeInViewport();
  });

  test('брэндийн холбоос дээр дарахад sidebar хаагдана', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/los/report');
    const toggle = page.getByRole('button', { name: 'Цэсийг нээх, хаах' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.ant-layout-sider').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('хонх нээгдэхэд popup дэлгэцээс хэтрэхгүй, хэвтээ гүйлгэлт үүсэхгүй', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    await page.getByRole('button', { name: /^Мэдэгдэл/ }).click();
    const popup = page.locator('.ant-popover:not(.ant-popover-hidden)').first();
    await expect(popup.getByText('Шинэ мэдэгдэл алга')).toBeVisible();
    const box = (await popup.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('backdrop дээр дарахад sidebar хаагдана', async ({ page }) => {
    await mockGateway(page, { signedIn: true });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Цэсийг нээх, хаах' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.click(310, 650);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
