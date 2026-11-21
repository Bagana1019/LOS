import { expect, test, type Page } from '@playwright/test';
import { guardConsole } from './mock-api';
import { mockGateway, type Gateway } from './mock-gateway';

// Түр нууц үгтэй хэрэглэгчийн албадмал «Нууц үгээ солино уу» дэлгэц (FR-13). Gateway-г mock хийсэн.
// F9-14: одоогийн нууц үгийг буруу бичихэд gateway одоо 401 биш 422 + INVALID_CURRENT_PASSWORD буцаана. Дэлгэц алдааг ТЭР талбарт заана;
// сесс хаахгүй, "Нэвтрэх хугацаа дууссан" гэсэн худал мессеж гаргахгүй, бичсэн шинэ нууц үг үлдэнэ.
const FAKE_CURRENT = 'wrong-temp-pass';
const FAKE_NEW = 'NewPassw0rd-ok';
const WRONG_CURRENT_TEXT = 'Одоогийн (түр) нууц үг буруу байна. Түр нууц үгээ анхааралтай дахин оруулна уу';
const SESSION_EXPIRED_TEXT = 'Нэвтрэх хугацаа дууссан';
const CHANGE_PATH = '/api/auth/change-password';

type Reply = { status: number; body: unknown } | 'fallback';

/** `POST /auth/change-password`-ийг дараалсан хариугаар тосно (mock-gateway-ийн 204-ийг дарж). Дуудлагын биеийг цуглуулна. */
async function stubChangePassword(page: Page, replies: Reply[]): Promise<{ bodies: unknown[] }> {
  const bodies: unknown[] = [];
  await page.route(
    (url) => url.pathname === CHANGE_PATH,
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      bodies.push(req.postDataJSON());
      const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
      if (reply === 'fallback') return route.fallback();
      return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    },
  );
  return { bodies };
}

const INVALID_CURRENT: Reply = { status: 422, body: { code: 'INVALID_CURRENT_PASSWORD', message: 'Одоогийн нууц үг буруу байна' } };

/** Playwright-д СҮҮЛД бүртгэсэн route түрүүлж ажиллана: mock-gateway-ийн дараа stub бүртгэж, түүний 204-ийг дарна. */
async function openForm(page: Page, replies: Reply[]): Promise<{ gw: Gateway; bodies: unknown[] }> {
  const gw = await mockGateway(page, { signedIn: true, role: 'OFFICER', authOnly: false, mustChangePassword: true });
  const { bodies } = await stubChangePassword(page, replies);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Нууц үгээ солино уу' })).toBeVisible();
  return { gw, bodies };
}

const currentField = (page: Page) => page.getByLabel('Одоогийн (түр) нууц үг');
const newField = (page: Page) => page.getByLabel('Шинэ нууц үг', { exact: true });
const againField = (page: Page) => page.getByLabel('Шинэ нууц үг (давтах)');
const submit = (page: Page) => page.getByRole('button', { name: 'Нууц үг солих' });
const currentItem = (page: Page) => page.locator('.ant-form-item', { has: page.locator('#pw-current') });
const sessionCalls = (gw: Gateway, from: number) => gw.requests.slice(from).filter((r) => /\/auth\/(refresh|logout|login)$/.test(r));

async function fillAll(page: Page) {
  await currentField(page).fill(FAKE_CURRENT);
  await newField(page).fill(FAKE_NEW);
  await againField(page).fill(FAKE_NEW);
}

test.describe('Албадмал нууц үг солих: одоогийн нууц үг буруу (F9-14)', () => {
  test('422 INVALID_CURRENT_PASSWORD shows an inline error on the current field and keeps the user on the form', async ({ page }) => {
    const guard = guardConsole(page);
    const { gw, bodies } = await openForm(page, [INVALID_CURRENT]);
    await fillAll(page);
    const before = gw.requests.length;

    await submit(page).click();

    await expect(currentItem(page).getByText(WRONG_CURRENT_TEXT)).toBeVisible();
    await expect(currentItem(page)).toHaveClass(/ant-form-item-has-error/);
    // Хэрэглэгч формдоо үлдэнэ: /login руу шилжээгүй, "сесс дууссан" мессеж байхгүй
    await expect(page.getByRole('heading', { name: 'Нууц үгээ солино уу' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(SESSION_EXPIRED_TEXT)).toHaveCount(0);
    // Нэг л дуудлага явсан; refresh / logout / login огт дуудагдаагүй
    expect(bodies).toHaveLength(1);
    expect(sessionCalls(gw, before)).toEqual([]);
    // Бичсэн утгууд хэвээр
    await expect(newField(page)).toHaveValue(FAKE_NEW);
    await expect(againField(page)).toHaveValue(FAKE_NEW);
    await expect(submit(page)).toBeEnabled();
    expect(guard.problems).toEqual([]);
  });

  test('retyping the current password clears the inline error and a second submit succeeds with the typed new password', async ({ page }) => {
    const { bodies } = await openForm(page, [INVALID_CURRENT, 'fallback']); // 2 дахь дуудлага mock-gateway-ийн 204
    await fillAll(page);
    await submit(page).click();
    await expect(currentItem(page).getByText(WRONG_CURRENT_TEXT)).toBeVisible();

    await currentField(page).fill('another-fake-temp');
    await expect(currentItem(page).getByText(WRONG_CURRENT_TEXT)).toHaveCount(0);
    await expect(newField(page)).toHaveValue(FAKE_NEW);
    await submit(page).click();

    await expect(page).toHaveURL(/\/login/); // амжилттай бол сесс хаагдаж нэвтрэх дэлгэц
    expect(bodies).toEqual([
      { currentPassword: FAKE_CURRENT, newPassword: FAKE_NEW },
      { currentPassword: 'another-fake-temp', newPassword: FAKE_NEW },
    ]);
  });

  test('other errors keep the form-level alert and leave the current field clean', async ({ page }) => {
    const { gw } = await openForm(page, [{ status: 422, body: { code: 'PASSWORD_UNCHANGED', message: 'x' } }]);
    await fillAll(page);
    const before = gw.requests.length;
    await submit(page).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Шинэ нууц үг одоогийнхоос өөр байх ёстой' })).toBeVisible();
    await expect(currentItem(page)).not.toHaveClass(/ant-form-item-has-error/);
    await expect(page).not.toHaveURL(/\/login/);
    expect(sessionCalls(gw, before)).toEqual([]);
  });
});
