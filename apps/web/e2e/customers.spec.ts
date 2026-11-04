import { expect, test } from '@playwright/test';
import { guardConsole, MockApi } from './mock-api';

// FR-2: сайдбарын «Харилцагч» → жагсаалт (/customer), «Харилцагч нэмэх» → /customer/new, бүртгээд карт (/customer/:id).
// Өмнө нь /customer хуудас байгаагүй тул сайдбараас дарахад «Хуудас олдсонгүй» (404) гардаг байсан.

const ID = '22222222-2222-4222-8222-222222222222';
const summary = { id: ID, customerType: 'INDIVIDUAL', registerNoMasked: 'УБ****0112', lastName: 'Болд', firstName: 'Бат', phone: '99112233', isPep: false, isRelatedParty: false, blacklisted: false, createdAt: '2026-11-03T00:00:00.000Z' };
const addr = { province: 'Улаанбаатар', district: 'БЗД', khoroo: '1-р хороо', detail: 'Байр 1' };
const view = {
  ...summary, registerNo: 'УБ90010112', gender: 'MALE', birthDate: '1990-01-01', email: 'bat@example.mn', photoFileId: null, familySize: 3, activitySector: 'Худалдаа', maritalStatus: 'MARRIED',
  segment: 'Жижиг', education: 'Бакалавр', isRelatedParty: false, isPep: false, amlRiskScore: null, officialAddress: addr, residenceAddress: null, residenceSameAsOfficial: true,
  employment: { organization: 'ХХК', position: 'Менежер' }, xypFetchedAt: '2026-11-03T00:00:00.000Z', branchId: 'branch', createdAt: summary.createdAt, updatedAt: summary.createdAt, contacts: [], warnings: [],
};

test('жагсаалт нээгдэнэ (404 биш) ба «Харилцагч нэмэх» товч харагдана', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  const guard = guardConsole(page);
  api.on('GET', '/customers', { json: { items: [summary], total: 1, page: 1, pageSize: 20 } });
  await page.goto('/customer');
  await expect(page.getByText('УБ****0112')).toBeVisible();
  await expect(page.getByText('Хуудас олдсонгүй')).toHaveCount(0);
  await expect(page.getByTestId('create-customer')).toBeVisible();
  expect(guard.problems).toEqual([]);
});

test('шинэ харилцагч: регистр → ХУР → дутууг бөглөх → бүртгэх → карт', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  api.on('POST', '/customers/xyp-fetch', {
    json: {
      registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', fetchedAt: '2026-11-03T00:00:00.000Z', existing: null, warnings: [],
      prefill: { lastName: 'Болд', firstName: 'Бат', gender: 'MALE', birthDate: '1990-01-01', maritalStatus: 'MARRIED', familySize: 3, officialAddress: addr, activitySector: 'Худалдаа' },
      prefilledFields: ['lastName', 'firstName', 'gender'], missing: ['phone', 'email'],
    },
  });
  api.on('POST', '/customers', { status: 201, json: view });
  api.on('GET', `/customers/${ID}`, { json: { ...view, applications: [] } });

  await page.goto('/customer/new');
  await page.getByTestId('customer-register').fill('уб90010112');
  await page.getByTestId('customer-check').click();
  await expect(page.getByTestId('customer-submit')).toBeVisible();

  // Дутуу бол алдаа гарч, сервер рүү дуудлага явахгүй
  await page.getByTestId('customer-submit').click();
  await expect(page.locator('.ant-form-item-explain-error').first()).toBeVisible();
  expect(api.callsTo('POST', '/customers')).toHaveLength(0);

  await page.locator('#phone').fill('99112233');
  await page.locator('#email').fill('bat@example.mn');
  await page.locator('#segment').fill('Жижиг');
  await page.locator('#education').fill('Бакалавр');
  await page.locator('#employment_organization').fill('ХХК');
  await page.locator('#employment_position').fill('Менежер');
  await page.getByLabel('Оршин суугаа хаяг нь албан ёсны хаягтай ижил').check();
  api.post('/dms/files', { status: 201, json: { id: '33333333-3333-4333-8333-333333333333', name: 'id.png', mime: 'image/png', size: 1 } });
  await page.setInputFiles('input[type=file]', { name: 'id.png', mimeType: 'image/png', buffer: Buffer.from('x') });
  await expect(page.getByRole('button', { name: 'Зураг орсон' })).toBeVisible();
  await page.getByTestId('customer-submit').click();

  await expect(page).toHaveURL(new RegExp(`/customer/${ID}$`));
  const sent = api.lastCall('POST', '/customers')?.body as Record<string, unknown>;
  expect(sent).toMatchObject({ registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', source: 'XYP', phone: '99112233', photoFileId: '33333333-3333-4333-8333-333333333333' });
  await expect(page.getByText('Харилцагчийн карт').or(page.getByText('Өмнөх зээлийн түүх'))).toBeVisible();
});

test('ХУР-аас татахад ургийн овог, иргэний бүртгэлийн дугаар гарна; холбоо барих хүний гэрийн хаяг 4 түвшинтэй', async ({ page }) => {
  const api = new MockApi('OFFICER');
  await api.install(page);
  api.on('POST', '/customers/xyp-fetch', {
    json: {
      registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', fetchedAt: '2026-11-03T00:00:00.000Z', existing: null, warnings: [],
      prefill: { lastName: 'Болд', clanName: 'Боржигин', civilId: '1234567890', firstName: 'Бат', gender: 'MALE', birthDate: '1990-01-01', officialAddress: addr, activitySector: 'Худалдаа', segment: 'Жижиглэн' },
      prefilledFields: ['lastName', 'clanName', 'civilId', 'firstName', 'activitySector', 'segment'], missing: ['phone'],
    },
  });
  await page.goto('/customer/new');
  await page.getByTestId('customer-register').fill('уб90010112');
  await page.getByTestId('customer-check').click();
  await expect(page.locator('#clanName')).toHaveValue('Боржигин');
  await expect(page.locator('#civilId')).toHaveValue('1234567890');
  await expect(page.locator('#activitySector')).toHaveValue('Худалдаа');
  await expect(page.locator('#segment')).toHaveValue('Жижиглэн');

  // Хөдөлмөр эрхлэлт: бүх талбарын input нэг мөрийн дотор ижил түвшинд (шошго нугалагдсан ч доош шилжихгүй)
  const y = async (id: string) => (await page.locator(id).boundingBox())!.y;
  expect(await y('#employment_address')).toBe(await y('#employment_phone'));
  expect(await y('#employment_organization')).toBe(await y('#employment_position'));

  // Холбоо барих хүн: гэрийн хаяг 4 түвшин + «Оршин суугаа хаягтай ижил»
  await page.getByLabel('Оршин суугаа хаяг нь албан ёсны хаягтай ижил').check();
  await page.getByRole('button', { name: 'Холбоо барих хүн нэмэх' }).click();
  await page.getByLabel('Оршин суугаа хаягтай ижил').check();
  await expect(page.locator('#contacts_0_homeAddress_province')).toHaveValue('Улаанбаатар');
  await expect(page.locator('#contacts_0_homeAddress_province')).toBeDisabled();
  await expect(page.locator('#contacts_0_homeAddress_detail')).toHaveValue('Байр 1');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
});
