import { expect, test, type Page } from '@playwright/test';
import { GoodsCategory, MerchantCreate, MerchantStatus, PosLeaseStatus } from '@los/contracts';
import { contrastRatio, MIN_TEXT_CONTRAST } from '../src/features/merchant/tag-tones';
import { expectClean, expectNoHorizontalScroll, setup, setupBackOffice, shot } from './helpers';
import { IDS, leaseId, makeAdminLease, makeLease, makeMerchantView, makePlanView, makeStoreView, paged, toListItem } from './fixtures';
import type { MockApi } from './mock-api';

// Back-office/мерчант порталын формын хязгаар (n=33), 1024–1280px хүснэгтийн байршил (n=34), шошгын контраст (n=20), утсан дээрх 16px фонт.

const NEW_ID = '11111111-1111-4111-8111-1111111111ff';

function installMerchantApi(api: MockApi) {
  const merchants = MerchantStatus.map((s, i) => makeMerchantView({ id: i === 0 ? IDS.merchant : `11111111-1111-4111-8111-1111111111a${i}`, code: `SHOP-${s}`, name: `Дэлгүүр ${i + 1} ХХК`, status: s }));
  api.get('/merchants', ({ search }) => ({ json: paged(merchants, Number(search.get('page') ?? 1), 20, merchants.length) }));
  api.get('/merchants/:id', ({ params }) => ({ json: merchants.find((m) => m.id === params.id) ?? merchants[0] }));
  api.get('/merchants/:id/stores', () => ({
    json: [
      makeStoreView(),
      makeStoreView({ id: IDS.storeB, code: 'UB-02', name: 'Зайсан салбар, Их тэнгэр худалдааны төвийн 3 давхарын компьютерын тасаг', isActive: false }),
    ],
  }));
  api.get('/pos-plans', () => ({
    json: [
      makePlanView(),
      { ...makePlanView({ id: IDS.planGlobal, code: 'GLOBAL-ALL-CATEGORIES', name: 'Стандарт глобал хөтөлбөр бүх ангилалд', merchantId: null }), goodsCategories: [...GoodsCategory] },
    ],
  }));
  api.get('/pos-leases', () => ({ json: paged([toListItem(makeAdminLease({ id: leaseId(11), status: 'DELIVERED', leaseNo: 'POS-261028-0011' }))]) }));
  return merchants;
}

async function fillMerchantForm(page: Page) {
  await page.locator('#code').fill('newshop');
  await page.locator('#name').fill('Шинэ дэлгүүр ХХК');
  await page.locator('#branchId').fill('BR-UB-02');
  await page.locator('#contactName').fill('Бат Дорж');
  await page.locator('#phone').fill('99001122');
  await page.locator('#commissionRate').fill('2');
  await page.locator('#maxTicketAmount').fill('5000000');
  await page.locator('#settlement_bankCode').fill('khan');
  await page.locator('#settlement_accountNo').fill('5012345678');
  await page.locator('#settlement_holderName').fill('Шинэ дэлгүүр ХХК');
}

test.describe('хязгаараас гарсан утгыг чимээгүй өөрчлөхгүй, монгол мессеж харуулна (n=33)', () => {
  test('merchant drawer: commission 25 stays 25 with the 0–20% message; zero ticket/daily limit stay 0 with the "greater than 0" message', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    api.post('/merchants', ({ body }) => {
      const parsed = MerchantCreate.parse(body);
      return { status: 201, json: makeMerchantView({ id: NEW_ID, code: parsed.code, name: parsed.name, status: 'PENDING' }) };
    });
    await page.goto('/settings/merchants');
    await page.getByRole('button', { name: 'Мерчант бүртгэх' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Мерчант бүртгэх' });
    await fillMerchantForm(page);

    await page.locator('#commissionRate').fill('25');
    await page.locator('#maxTicketAmount').fill('0');
    await page.locator('#dailyLimitAmount').fill('0');
    await page.locator('#code').click(); // blur: antd InputNumber энэ мөчид min/max-аар чимээгүй clamp хийдэг байсан
    await expect(page.locator('#commissionRate')).toHaveValue('25.00');
    await expect(page.locator('#maxTicketAmount')).toHaveValue('0');
    await expect(page.locator('#dailyLimitAmount')).toHaveValue('0');

    await drawer.getByRole('button', { name: 'Бүртгэх' }).click();
    await expect(drawer.getByText('Шимтгэл 0–20% байх ёстой')).toBeVisible();
    await expect(drawer.getByText('Дүнг оруулна уу (0-ээс их)')).toHaveCount(2);
    expect(api.callsTo('POST', '/merchants')).toHaveLength(0);
    await expect(page.locator('#commissionRate')).toHaveValue('25.00'); // илгээсний дараа ч өөрчлөгдөөгүй
    await shot(page, 'backoffice-merchant-drawer-errors');

    // Зассаны дараа амжилттай: өдрийн лимит хоосон = лимитгүй
    await page.locator('#commissionRate').fill('20');
    await page.locator('#maxTicketAmount').fill('5000000');
    await page.locator('#dailyLimitAmount').fill('');
    await drawer.getByRole('button', { name: 'Бүртгэх' }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/merchants/${NEW_ID}$`));
    expect(api.lastCall('POST', '/merchants')!.body).toMatchObject({ commissionRate: 0.2, maxTicketAmount: 5_000_000, dailyLimitAmount: null });
    expectClean(guard, api);
  });

  test('plan modal: commission 25, annual rate 150 and policy DTI 150 are kept and explained, nothing is posted', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    await page.goto(`/settings/merchants/${IDS.merchant}?tab=plans`);
    await page.getByRole('button', { name: 'Хөтөлбөр нэмэх' }).click();
    const modal = page.getByRole('dialog', { name: 'Хөтөлбөр нэмэх' });
    await modal.getByRole('button', { name: /Нарийвчилсан бодлого/ }).click();

    await modal.locator('#commissionRate').fill('25');
    await modal.locator('#annualRate').fill('150');
    await modal.locator('#policy_maxDti').fill('150');
    await modal.locator('#code').click();
    await expect(modal.locator('#commissionRate')).toHaveValue('25.00');
    await expect(modal.locator('#annualRate')).toHaveValue('150.00');
    await expect(modal.locator('#policy_maxDti')).toHaveValue('150.00');

    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal.getByText('0–20% хооронд оруулна уу').first()).toBeVisible();
    await expect(modal.getByText('0–100% хооронд оруулна уу')).toHaveCount(2); // жилийн хүү + бодлогын ӨОХ
    expect(api.callsTo('POST', '/pos-plans')).toHaveLength(0);
    await expect(modal.locator('#commissionRate')).toHaveValue('25.00');
    expectClean(guard, api);
  });
});

test.describe('хүснэгтийн байршил 1024–1280px (n=34)', () => {
  for (const width of [1024, 1152, 1280]) {
    test(`plans and stores tables at ${width}px: long cells are cut with a tooltip, status and actions stay visible on the right`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { api, guard } = await setupBackOffice(page);
      installMerchantApi(api);

      await page.goto(`/settings/merchants/${IDS.merchant}?tab=plans`);
      const plans = page.getByRole('table', { name: 'Лизингийн хөтөлбөрүүд' });
      const planRow = plans.getByRole('row', { name: /GLOBAL-ALL-CATEGORIES/ });
      await expect(planRow).toBeVisible();
      await expect(planRow.getByRole('button', { name: 'Засах' })).toBeInViewport({ ratio: 1 });
      await expect(planRow.getByText('Идэвхтэй', { exact: true })).toBeInViewport({ ratio: 1 });
      const cats = planRow.locator('.mp-ellipsis[title*="Компьютер"]');
      await expect(cats).toHaveCount(1);
      expect(await cats.getAttribute('title')).toContain(', '); // бүх ангилал tooltip-д бүтнээрээ
      expect((await planRow.boundingBox())!.height, 'row stays single-line').toBeLessThan(90);
      await expectNoHorizontalScroll(page);
      await shot(page, `plans-table-${width}`);

      await page.goto(`/settings/merchants/${IDS.merchant}?tab=stores`);
      const stores = page.getByRole('table', { name: 'Дэлгүүрүүд' });
      const storeRow = stores.getByRole('row', { name: /UB-02/ });
      await expect(storeRow).toBeVisible();
      await expect(storeRow.getByRole('button', { name: 'Засах' })).toBeInViewport({ ratio: 1 });
      await expect(storeRow.getByText('Идэвхгүй', { exact: true })).toBeInViewport({ ratio: 1 });
      expect((await storeRow.boundingBox())!.height, 'row stays single-line').toBeLessThan(90);
      await expectNoHorizontalScroll(page);
      expectClean(guard, api);
    });

    test(`lease list at ${width}px: status column is pinned right and always visible, long names are cut with a tooltip`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { api, guard } = await setup(page, { role: 'MERCHANT_ADMIN' });
      const long = makeLease({
        id: leaseId(300), leaseNo: 'POS-261028-0300', status: 'APPROVED', goodsName: 'Apple MacBook Pro 16-inch M3 Max 64GB RAM 2TB SSD Space Black Тусгай захиалгын загвар',
        buyerName: 'Бат-Эрдэнийн Болормаа Сарангэрэл Дашдондог', storeName: 'Зайсан салбар, Их тэнгэр худалдааны төвийн 3 давхар',
      });
      api.get('/merchant-portal/leases', () => ({ json: paged([toListItem(long), ...PosLeaseStatus.slice(0, 4).map((s, i) => toListItem(makeLease({ id: leaseId(310 + i), leaseNo: `POS-261028-031${i}`, status: s })))]) }));
      await page.goto('/merchant/leases');
      const table = page.getByRole('table', { name: 'Лизингүүд' });
      const row = table.getByRole('row', { name: /POS-261028-0300/ });
      await expect(row).toBeVisible();
      await expect(row.getByText('Батлагдсан', { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(row.locator('.mp-ellipsis[title*="MacBook Pro"]')).toHaveCount(1);
      await expect(row.locator('.mp-ellipsis[title*="Болормаа"]')).toHaveCount(1);
      expect((await row.boundingBox())!.height, 'row stays single-line').toBeLessThan(90);
      await expectNoHorizontalScroll(page);
      await shot(page, `lease-table-${width}`);
      expectClean(guard, api);
    });
  }
});

/** Хуудсан дээрх бүх `.ant-tag`-ийн бодит (computed) өнгө/дэвсгэрийн контраст. */
async function tagContrasts(page: Page): Promise<Array<{ text: string; ratio: number }>> {
  const raw = await page.evaluate(() => {
    const effectiveBg = (el: Element): string => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      }
      return 'rgb(255, 255, 255)';
    };
    return [...document.querySelectorAll('.ant-tag')]
      .filter((el) => el.getClientRects().length > 0 && (el.textContent ?? '').trim() !== '')
      .map((el) => ({ text: (el.textContent ?? '').trim(), fg: getComputedStyle(el).color, bg: effectiveBg(el) }));
  });
  const hex = (rgb: string): string => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    if (!m) throw new Error(`unexpected colour ${rgb}`);
    return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  };
  return raw.map((r) => ({ text: r.text, ratio: contrastRatio(hex(r.fg), hex(r.bg)) }));
}

test.describe('шошгын контраст WCAG AA 4.5:1 (n=20)', () => {
  test('lease status tags: every status passes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { api, guard } = await setup(page, { role: 'MERCHANT_ADMIN' });
    const all = PosLeaseStatus.map((s, i) => toListItem(makeLease({ id: leaseId(400 + i), leaseNo: `POS-261028-04${String(i).padStart(2, '0')}`, status: s })));
    api.get('/merchant-portal/leases', () => ({ json: paged(all) }));
    await page.goto('/merchant/leases');
    await expect(page.getByRole('table', { name: 'Лизингүүд' })).toContainText('POS-261028-0400');
    const tags = await tagContrasts(page);
    expect(tags.length, 'one tag per lease status').toBeGreaterThanOrEqual(PosLeaseStatus.length);
    expect(tags.filter((t) => t.ratio < MIN_TEXT_CONTRAST), 'lease tags below 4.5:1').toEqual([]);
    expectClean(guard, api);
  });

  test('merchant status, scope and active tags (back-office) pass', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    await page.goto('/settings/merchants');
    await expect(page.getByRole('table', { name: 'Мерчант' })).toContainText('SHOP-TERMINATED');
    const merchantTags = await tagContrasts(page);
    expect(merchantTags.length).toBeGreaterThanOrEqual(MerchantStatus.length);
    expect(merchantTags.filter((t) => t.ratio < MIN_TEXT_CONTRAST), 'merchant tags below 4.5:1').toEqual([]);

    await page.goto(`/settings/merchants/${IDS.merchant}?tab=plans`);
    await expect(page.getByRole('table', { name: 'Лизингийн хөтөлбөрүүд' })).toContainText('GLOBAL-ALL-CATEGORIES');
    const planTags = await tagContrasts(page);
    expect(planTags.length).toBeGreaterThan(0);
    expect(planTags.filter((t) => t.ratio < MIN_TEXT_CONTRAST), 'plan tags below 4.5:1').toEqual([]);

    await page.goto(`/settings/merchants/${IDS.merchant}?tab=stores`);
    await expect(page.getByRole('table', { name: 'Дэлгүүрүүд' })).toContainText('UB-02');
    const storeTags = await tagContrasts(page);
    expect(storeTags.length).toBeGreaterThan(0);
    expect(storeTags.filter((t) => t.ratio < MIN_TEXT_CONTRAST), 'store tags below 4.5:1').toEqual([]);
    expectClean(guard, api);
  });

  test('admin lease drawer: reason severity tags pass', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    const referred = makeAdminLease({ id: leaseId(21), leaseNo: 'POS-261028-0021', status: 'REFERRED', decision: { publicReason: 'MANUAL_REVIEW' } });
    api.get('/pos-leases/:id', () => ({ json: referred }));
    api.get('/pos-leases', () => ({ json: paged([toListItem(referred)]) }));
    await page.goto('/los/pos-leases');
    await page.getByRole('row', { name: /POS-261028-0021/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Лизинг POS-261028-0021' });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.ant-tag').first()).toBeVisible();
    const tags = await tagContrasts(page);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    expect(tags.filter((t) => t.ratio < MIN_TEXT_CONTRAST), 'drawer tags below 4.5:1').toEqual([]);
    expectClean(guard, api);
  });
});

test.describe('утас: back-office drawer/modal-ийн оролт 16px-ээс багагүй', () => {
  for (const width of [320, 375]) {
    test(`merchant drawer and plan modal at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { api, guard } = await setupBackOffice(page);
      installMerchantApi(api);
      const small = () =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.ant-drawer input, .ant-drawer textarea, .ant-modal input, .ant-modal textarea')]
            .filter((el) => !['hidden', 'radio', 'checkbox'].includes((el as HTMLInputElement).type) && el.getClientRects().length > 0)
            .map((el) => ({ what: el.id || el.getAttribute('aria-label') || el.className, size: parseFloat(getComputedStyle(el).fontSize) }))
            .filter((c) => c.size < 16),
        );
      await page.goto('/settings/merchants');
      await page.getByRole('button', { name: 'Мерчант бүртгэх' }).first().click();
      await expect(page.getByRole('dialog', { name: 'Мерчант бүртгэх' })).toBeVisible();
      await expect(page.locator('#commissionRate')).toBeVisible();
      expect(await small(), 'merchant drawer controls under 16px').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Мерчант бүртгэх' })).toBeHidden();

      await page.goto(`/settings/merchants/${IDS.merchant}?tab=plans`);
      await page.getByRole('button', { name: 'Хөтөлбөр нэмэх' }).click();
      const modal = page.getByRole('dialog', { name: 'Хөтөлбөр нэмэх' });
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: /Нарийвчилсан бодлого/ }).click();
      expect(await small(), 'plan modal controls under 16px').toEqual([]);
      expectClean(guard, api);
    });
  }
});
