import { expect, test, type Page } from '@playwright/test';
import { mockGateway } from './mock-gateway';

// ══ G4 · F9-15: албадмал нууц үг солих — шаардлагын чеклист, товч яагаад идэвхгүй ══════════════════════════════════════════════
const PW_CURRENT = 'tmp-Pass-123';
const PW_NEW = 'Abcdefghij1k';
const PW_CHANGE_PATH = '/api/auth/change-password';

/** `POST /auth/change-password`-ийг тогтсон хариугаар тосно (mock-gateway-ийн 204-ийг дарж). */
async function pwStub(page: Page, reply: { status: number; body: unknown }): Promise<{ bodies: unknown[] }> {
  const bodies: unknown[] = [];
  await page.route((url) => url.pathname === PW_CHANGE_PATH, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
  });
  return { bodies };
}

async function openPasswordForm(page: Page, reply?: { status: number; body: unknown }): Promise<{ bodies: unknown[] }> {
  await mockGateway(page, { signedIn: true, role: 'OFFICER', authOnly: false, mustChangePassword: true });
  const stub = reply ? await pwStub(page, reply) : { bodies: [] };
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Нууц үгээ солино уу' })).toBeVisible();
  return stub;
}

const pwCurrent = (page: Page) => page.getByLabel('Одоогийн (түр) нууц үг');
const pwNew = (page: Page) => page.getByLabel('Шинэ нууц үг', { exact: true });
const pwAgain = (page: Page) => page.getByLabel('Шинэ нууц үг (давтах)');
const pwSubmit = (page: Page) => page.getByRole('button', { name: 'Нууц үг солих' });
const pwCheck = (page: Page, key: string) => page.locator(`[data-check="${key}"]`);
const pwReason = (page: Page) => page.locator('#pw-blocked');

test.describe('G4 · албадмал нууц үг солих: чеклист ба идэвхгүй товчны шалтгаан (F9-15)', () => {
  test('шаардлагын чеклист бодит цагт шинэчлэгдэнэ; "латин үсэг" гэж заана; кирилл нууц үгэнд том/жижиг латин үсэг биелэхгүй', async ({ page }) => {
    await openPasswordForm(page);
    const list = page.getByRole('list', { name: /Шинэ нууц үг дараах бүгдийг хангах ёстой/ });
    await expect(list).toBeVisible();
    await expect(list).toContainText('Хамгийн багадаа 12 тэмдэгт (одоо 0)');
    await expect(list).toContainText('Том латин үсэг (A–Z)');
    await expect(list).toContainText('Жижиг латин үсэг (a–z)');
    await expect(list).toContainText('Тоо (0–9)');
    for (const key of ['length', 'upper', 'lower', 'digit']) await expect(pwCheck(page, key)).toHaveAttribute('data-met', 'false');

    await pwNew(page).fill('123456');
    await expect(pwCheck(page, 'length')).toContainText('(одоо 6)');
    await expect(pwCheck(page, 'digit')).toHaveAttribute('data-met', 'true');
    await expect(pwCheck(page, 'digit')).toContainText('биелсэн'); // өнгө/дүрсээс гадна текстээр (screen reader)
    await expect(pwCheck(page, 'upper')).toContainText('биелээгүй');

    await pwNew(page).fill('Бат Болд 1234567'); // finding-ийн оролт: 16 тэмдэгт ч латин үсэггүй
    await expect(pwCheck(page, 'length')).toHaveAttribute('data-met', 'true');
    await expect(pwCheck(page, 'upper')).toHaveAttribute('data-met', 'false');
    await expect(pwCheck(page, 'lower')).toHaveAttribute('data-met', 'false');

    await pwNew(page).fill('password12345');
    await expect(pwCheck(page, 'upper')).toHaveAttribute('data-met', 'false');
    await expect(pwCheck(page, 'lower')).toHaveAttribute('data-met', 'true');

    await pwNew(page).fill(PW_NEW);
    for (const key of ['length', 'upper', 'lower', 'digit']) await expect(pwCheck(page, key)).toHaveAttribute('data-met', 'true');
  });

  test('товч идэвхгүй үед шалтгааныг нь шатлалаар хэлнэ; бэлэн болмогц шалтгаан арилж товч идэвхжинэ', async ({ page }) => {
    await openPasswordForm(page);
    await expect(pwSubmit(page)).toBeDisabled();
    await expect(pwReason(page)).toHaveText('Товч идэвхгүй байна: одоогийн (түр) нууц үгээ оруулна уу');
    await expect(pwSubmit(page)).toHaveAttribute('aria-describedby', 'pw-blocked'); // screen reader товчны шалтгааныг уншина

    await pwCurrent(page).fill(PW_CURRENT);
    await expect(pwReason(page)).toHaveText('Товч идэвхгүй байна: шинэ нууц үг дээрх шаардлагыг бүрэн хангах ёстой');

    await pwNew(page).fill(PW_CURRENT); // шаардлага хангасан ч одоогийнхтойгоо ижил
    await expect(pwReason(page)).toHaveText('Товч идэвхгүй байна: шинэ нууц үг одоогийнхоос өөр байх ёстой');

    await pwNew(page).fill(PW_NEW);
    await expect(pwReason(page)).toHaveText('Товч идэвхгүй байна: шинэ нууц үгээ давтан оруулна уу');

    await pwAgain(page).fill(`${PW_NEW}x`);
    await expect(pwReason(page)).toHaveText('Товч идэвхгүй байна: давтсан нууц үг шинэ нууц үгтэй таарахгүй байна');
    await expect(page.getByText('Нууц үг таарахгүй байна')).toBeVisible(); // талбарын доорх өмнөх алдаа хэвээр

    await pwAgain(page).fill(PW_NEW);
    await expect(pwReason(page)).toHaveCount(0);
    await expect(pwSubmit(page)).toBeEnabled();
    await expect(pwSubmit(page)).not.toHaveAttribute('aria-describedby', /.+/);
  });

  test('серверийн алдаа (PASSWORD_UNCHANGED) талбар засагдмагц хэвээр үлдэхгүй — stale алдаа арилна', async ({ page }) => {
    const { bodies } = await openPasswordForm(page, { status: 422, body: { code: 'PASSWORD_UNCHANGED', message: 'x' } });
    await pwCurrent(page).fill(PW_CURRENT);
    await pwNew(page).fill(PW_NEW);
    await pwAgain(page).fill(PW_NEW);
    await pwSubmit(page).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Шинэ нууц үг одоогийнхоос өөр байх ёстой' });
    await expect(alert).toBeVisible();
    expect(bodies).toHaveLength(1);

    await pwNew(page).fill(`${PW_NEW}2`); // засав
    await expect(alert).toHaveCount(0); // хуучин алдаа үлдэхгүй
    await pwAgain(page).fill(`${PW_NEW}2`);
    await expect(pwSubmit(page)).toBeEnabled();
  });
});
