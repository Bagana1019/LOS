import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../lib/api';
import * as borrowers from './borrowers/borrowers.api';
import * as collateral from './collateral/collateral.api';
import * as documents from './documents/documents.api';
import { downloadDmsFile, uploadDmsFile } from './documents/shared/files';
import * as notifications from './notifications/notifications.api';
import * as payments from './payments/payments.api';
import * as reports from './reports/reports.api';

// Gateway зөвхөн `/api/<service>/*`-ийг дамжуулдаг (apps/gateway proxy.controller). origination-ий endpoint-ууд `/api/origination/…`;
// угтвар дутвал бодит gateway 404 өгнө, mock-той e2e үүнийг нуудаг тул энд тогтооно.
let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('origination-ий feature API-ууд gateway-ийн `/origination` угтвартай', () => {
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ['borrowers: list', () => borrowers.fetchBorrowers('a1'), '/applications/a1/borrowers'],
    ['payments: providers', () => payments.fetchProviders(), '/payments/providers'],
    ['payments: history', () => payments.fetchPayments('a1'), '/applications/a1/payments'],
    ['reports: definitions', () => reports.fetchReportDefinitions(), '/reports'],
    ['reports: dashboard', () => reports.fetchDashboard({}), '/reports/dashboard/summary'],
    ['notifications: bell count', () => notifications.fetchUnreadCount(), '/notifications/unread-count'],
    ['notifications: templates', () => notifications.fetchTemplates(), '/notifications/templates'],
  ];
  it.each(cases)('%s', async (_name, call, path) => {
    await call();
    expect(urls).toEqual([`${API}/origination${path}`]);
  });
});

// Барьцаа, баримтын алхам (docs/05-collateral-documents.md §3): origination-ийн замууд `/api/origination/…`, файл сан (dms) `/api/dms/files…`.
// Хариу нь схемд нийцэхгүй ({}) тул дуудлага шалгалтад унана — энд зөвхөн илгээсэн хаяг, method-ыг шалгана.
describe('барьцаа, баримтын API-ууд gateway-ийн зөв хаягаар дуудна', () => {
  let requests: Array<{ url: string; method: string }>;
  beforeEach(() => {
    requests = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? 'GET' });
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const A = 'a/1'; // зориуд тусгай тэмдэгттэй — encodeURIComponent
  const base = `${API}/origination/applications/a%2F1`;
  const cases: Array<[string, () => Promise<unknown>, string, string]> = [
    ['collateral: list', () => collateral.fetchCollaterals(A), 'GET', `${base}/collaterals`],
    ['collateral: create', () => collateral.createCollateral(A, {} as never), 'POST', `${base}/collaterals`],
    ['collateral: update', () => collateral.updateCollateral(A, 'c1', {} as never), 'PATCH', `${base}/collaterals/c1`],
    ['collateral: remove', () => collateral.removeCollateral(A, 'c1'), 'DELETE', `${base}/collaterals/c1`],
    ['collateral: recheck', () => collateral.recheckCollaterals(A), 'POST', `${base}/collaterals/recheck`],
    ['collateral: xyp assets', () => collateral.fetchXypAssets(A, 'o1'), 'GET', `${base}/collaterals/xyp-assets?ownerCustomerId=o1`],
    ['collateral: ownership check', () => collateral.checkOwnership(A, 'c1', {} as never), 'POST', `${base}/collaterals/c1/ownership-check`],
    ['collateral: encumbrance check', () => collateral.checkEncumbrance(A, 'c1', {} as never), 'POST', `${base}/collaterals/c1/encumbrance-check`],
    ['collateral: valuation suggest', () => collateral.suggestValuation(A, 'c1', {}), 'POST', `${base}/collaterals/c1/valuation/suggest`],
    ['collateral: valuation save', () => collateral.saveValuation(A, 'c1', {}), 'POST', `${base}/collaterals/c1/valuation`],
    ['collateral: valuation external', () => collateral.recordExternalValuation(A, 'c1', {} as never), 'POST', `${base}/collaterals/c1/valuation/external`],
    ['collateral: valuation history', () => collateral.fetchValuationHistory(A, 'c1'), 'GET', `${base}/collaterals/c1/valuations`],
    ['collateral: attach document', () => collateral.attachCollateralDocument(A, 'c1', {} as never), 'POST', `${base}/collaterals/c1/documents`],
    ['collateral: detach document', () => collateral.detachCollateralDocument(A, 'c1', 'd1'), 'DELETE', `${base}/collaterals/c1/documents/d1`],
    ['collateral: registry', () => collateral.registerPledge(A, 'c1', {} as never), 'POST', `${base}/collaterals/c1/registry`],
    ['collateral: release', () => collateral.releaseCollateral(A, 'c1'), 'POST', `${base}/collaterals/c1/release`],
    ['collateral: monitoring', () => collateral.fetchCollateralMonitoring(30), 'GET', `${API}/origination/collaterals/monitoring?withinDays=30`],
    ['documents: list', () => documents.fetchDocuments(A), 'GET', `${base}/documents`],
    ['documents: attach', () => documents.attachDocument(A, {} as never), 'POST', `${base}/documents`],
    ['documents: remove', () => documents.removeDocument(A, 'd1'), 'DELETE', `${base}/documents/d1`],
    ['documents: ocr', () => documents.ocrCheckDocument(A, 'd1'), 'POST', `${base}/documents/d1/ocr`],
    ['dms: upload', () => uploadDmsFile(new File(['x'], 'a.pdf')), 'POST', `${API}/dms/files`],
  ];
  it.each(cases)('%s', async (_name, call, method, url) => {
    await call().catch(() => undefined);
    expect(requests).toEqual([{ url, method }]);
  });

  it('dms: татах нь /api/dms/files/:id/content (блоб)', async () => {
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined, remove: () => undefined }), body: { appendChild: () => undefined } });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      await downloadDmsFile('f 1', 'a.pdf');
      expect(requests).toEqual([{ url: `${API}/dms/files/f%201/content`, method: 'GET' }]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:x');
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });
});
