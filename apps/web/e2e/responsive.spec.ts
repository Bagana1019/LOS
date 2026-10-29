import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, setup, setupBackOffice, expectClean } from './helpers';
import { IDS, leaseId, makeAdminLease, makeDashboard, makeLease, makeMerchantView, makePlanView, makeStoreView, paged, sampleLeases, toListItem } from './fixtures';
import type { MockApi } from './mock-api';

// Хүртээмж ба responsive: 320px–1440px-д хуудас хэвтээ гүйлгэгдэхгүй, консолд алдаа/анхааруулга байхгүй, интерактив элемент бүр нэртэй, id давхцахгүй.

const WIDTHS = [320, 375, 768, 1024, 1440] as const;

/** Харагдаж буй интерактив элемент бүрийн хүртээмжтэй нэр байгаа эсэх, давхардсан id байхгүй эсэх. */
async function expectAccessibleBasics(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const textOf = (id: string | null) => (id ? id.split(/\s+/).map((i) => document.getElementById(i)?.textContent?.trim() ?? '').join(' ').trim() : '');
    const nameOf = (el: Element): string => {
      const e = el as HTMLElement;
      const aria = e.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelled = textOf(e.getAttribute('aria-labelledby'));
      if (labelled) return labelled;
      if (e.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
        if (lab?.textContent?.trim()) return lab.textContent.trim();
      }
      const wrap = e.closest('label');
      if (wrap?.textContent?.trim()) return wrap.textContent.trim();
      if (e.textContent?.trim()) return e.textContent.trim();
      return (e.getAttribute('title') ?? e.getAttribute('placeholder') ?? '').trim();
    };
    for (const el of Array.from(document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=combobox], [role=tab], [role=radio]'))) {
      if (!visible(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (!nameOf(el)) out.push(`no accessible name: <${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 60)}">`);
    }
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1 && !id.startsWith('rc_') ) out.push(`duplicate id "${id}" x${n}`);
    if (document.documentElement.lang !== 'mn') out.push(`html lang is "${document.documentElement.lang}"`);
    if (document.querySelectorAll('h1').length !== 1) out.push(`expected exactly one h1, found ${document.querySelectorAll('h1').length}`);
    return out;
  });
  expect(problems, 'accessibility basics').toEqual([]);
}

function merchantMocks(api: MockApi) {
  const leases = sampleLeases();
  api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
  api.get('/merchant-portal/leases', () => ({ json: paged(leases.map(toListItem), 1, 20, 45) }));
  api.get('/merchant-portal/leases/:id', ({ params }) => ({ json: leases.find((l) => l.id === params.id) ?? makeLease({ id: params.id!, status: 'APPROVED' }) }));
  api.post('/merchant-portal/quotes', () => ({ status: 422, json: { code: 'VALIDATION_FAILED', message: 'x' } }));
  return leases;
}

for (const width of WIDTHS) {
  test.describe(`viewport ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 800 : 900 } });
    test.setTimeout(150_000); // бүх хуудсыг нэг тестэд гүйдэг (axe + overflow) — 3 worker зэрэг ачаалалтай үед 60с-д багтахгүй

    test('merchant portal pages', async ({ page }) => {
      const { api, guard } = await setup(page, { role: 'MERCHANT_ADMIN' });
      const leases = merchantMocks(api);
      const urls: Array<[string, string | RegExp]> = [
        ['/merchant', 'kpi-requests'],
        ['/merchant/leases', 'table-or-list'],
        ['/merchant/leases/new', 'form'],
        [`/merchant/leases/${leaseId(1)}`, 'detail'], // APPROVED
        [`/merchant/leases/${leaseId(3)}`, 'detail'], // DECLINED
        [`/merchant/leases/${leaseId(4)}`, 'detail'], // REFERRED
        [`/merchant/leases/${leaseId(2)}`, 'detail'], // DELIVERED
      ];
      expect(leases.length).toBeGreaterThan(5);
      for (const [url, ready] of urls) {
        await page.goto(url);
        if (ready === 'kpi-requests') await expect(page.getByTestId('kpi-requests')).toBeVisible();
        else if (ready === 'table-or-list') await expect(page.getByText('POS-261028-0007').first()).toBeVisible();
        else if (ready === 'form') await expect(page.getByRole('heading', { name: 'Шинэ лизинг', level: 1 })).toBeVisible();
        else await expect(page.getByRole('heading', { level: 1 })).toContainText('POS-');
        await test.step(`no horizontal scroll: ${url}`, () => expectNoHorizontalScroll(page));
        await expectAccessibleBasics(page);
      }
      expect(api.unhandled).toEqual([]);
      expect(guard.problems).toEqual([]);
    });

    test('back-office pages', async ({ page }) => {
      const { api, guard } = await setupBackOffice(page);
      const merchant = makeMerchantView();
      api.get('/merchants', () => ({ json: paged([merchant], 1, 20, 1) }));
      api.get('/merchants/:id', () => ({ json: merchant }));
      api.get('/merchants/:id/stores', () => ({ json: [makeStoreView(), makeStoreView({ id: IDS.storeB, code: 'UB-02', name: 'Зайсан салбар' })] }));
      api.get('/pos-plans', () => ({ json: [makePlanView(), makePlanView({ id: IDS.planGlobal, code: 'GLOBAL-STD', name: 'Стандарт глобал', merchantId: null })] }));
      const admin = makeAdminLease({ id: leaseId(21), status: 'REFERRED', leaseNo: 'POS-261028-0021' });
      api.get('/pos-leases', () => ({ json: paged([toListItem(admin)]) }));
      api.get('/pos-leases/:id', () => ({ json: admin }));

      for (const url of ['/settings/merchants', `/settings/merchants/${IDS.merchant}`, `/settings/merchants/${IDS.merchant}?tab=stores`, `/settings/merchants/${IDS.merchant}?tab=plans`, '/los/pos-leases']) {
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('.ant-skeleton')).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await expectAccessibleBasics(page);
      }
      // drawer / modal нээлттэй үед ч хуудас хэвтээ гүйлгэгдэхгүй
      await page.goto('/los/pos-leases');
      await page.getByRole('row', { name: /POS-261028-0021/ }).or(page.getByRole('button', { name: /POS-261028-0021/ })).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoHorizontalScroll(page);
      expectClean(guard, api);
    });
  });
}
