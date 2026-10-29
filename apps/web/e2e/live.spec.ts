import { expect, test, type Page } from '@playwright/test';

// Бодит gateway + seed (docs/00-foundation.md §1). Нууц үг: SEED_PASSWORD (анхдагч Los@2026!dev).
// Gateway нэвтрэх endpoint IP тутамд минутад 10 (LOGIN_RATE_LIMIT) — тестүүд цөөн нэвтэрнэ.
const PASSWORD = process.env.SEED_PASSWORD ?? 'Los@2026!dev';

async function signIn(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel('Нэвтрэх нэр').fill(username);
  await page.getByLabel('Нууц үг').fill(PASSWORD);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible();
}
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

test('бодит gateway: ЗЭЗ нэвтэрч, цэсээ харж, гарна', async ({ page }) => {
  await signIn(page, 'officer.a');
  await expect(menuItem(page, 'Тайлан')).toBeVisible();
  await expect(menuItem(page, 'Тохиргоо')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Сайн байна уу/ })).toBeVisible(); // refresh cookie-ээр сэргэсэн
  await page.getByRole('button', { name: 'Хэрэглэгчийн цэс' }).click();
  await page.getByRole('menuitem', { name: 'Гарах' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});

test('бодит gateway: Админ Тохиргоо цэстэй', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(menuItem(page, 'Тохиргоо')).toBeVisible();
});
