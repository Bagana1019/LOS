import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PAYMENT_CALLBACKS, ROUTE_POLICIES, isAmbiguousPath, isInternalOnly, isMerchantPortalPath, requiredPermission } from './route-policy';

describe('isMerchantPortalPath (docs/05-merchant-pos.md §8: merchant principals reach ONLY the merchant portal)', () => {
  it.each([
    '/api/origination/merchant-portal/me',
    '/api/origination/merchant-portal/leases/abc/submit',
    '/api/origination/merchant-portal',
    '/API/Origination/Merchant-Portal/me',
  ])('%s is a merchant portal path', (p) => expect(isMerchantPortalPath(p)).toBe(true));

  it.each([
    '/api/origination/applications',
    '/api/origination/pos-leases',
    '/api/origination/merchants',
    '/api/origination/pos-plans',
    '/api/origination/merchant-portalx/me',
    '/api/kyc/merchant-portal/me',
    '/api/origination/settings',
    '/api/admin/users',
  ])('%s is not', (p) => expect(isMerchantPortalPath(p)).toBe(false));
});

describe('requiredPermission (FR-5.5 pricing tiers)', () => {
  const tiers = '/api/origination/loan-terms/pricing/tiers';
  it('changing the rate card needs settings:manage; reading it and asking for a quote do not', () => {
    expect(requiredPermission('PUT', tiers)).toBe('settings:manage');
    expect(requiredPermission('GET', tiers)).toBeNull();
    expect(requiredPermission('POST', '/api/origination/loan-terms/pricing/quote')).toBeNull();
  });
  it('does not match look-alike prefixes', () => {
    expect(requiredPermission('PUT', `${tiers}-x`)).toBeNull();
  });
});

describe('requiredPermission (AML hit review — docs/05-compliance-aml.md §7)', () => {
  it('the review queue and hit decisions need aml:review (COMPLIANCE), read and write alike', () => {
    expect(requiredPermission('GET', '/api/kyc/aml/hits')).toBe('aml:review');
    expect(requiredPermission('GET', '/api/KYC/aml/hits')).toBe('aml:review');
    expect(requiredPermission('POST', '/api/kyc/aml/hits/00000000-0000-4000-8000-000000000001/review')).toBe('aml:review');
  });
  it('screening, its detail and the per-customer latest result stay open to any signed-in user (kyc checks roles)', () => {
    expect(requiredPermission('POST', '/api/kyc/aml/screen')).toBeNull();
    expect(requiredPermission('GET', '/api/kyc/aml/screenings/s-1')).toBeNull();
    expect(requiredPermission('GET', '/api/kyc/aml/hitsx')).toBeNull();
  });
});

describe('isInternalOnly (FR-8 scoring: хүрээг origination шалгана)', () => {
  const hidden = [
    '/api/scoring/underwrite', '/api/scoring/underwrite/preview', '/api/scoring/underwrite/applications/app-1/latest', '/api/scoring/underwrite/applications/app-1/selection',
    '/api/scoring/underwrite/applications/app-1/stale', '/api/scoring/sosco/score', '/api/scoring/sosco/results', '/api/scoring/sosco/results/latest',
  ];
  it.each(hidden)('%s нь ажилтанд 404 (дотоод)', (p) => {
    expect(isInternalOnly(p)).toBe(true);
  });
  it('том/жижиг үсэг, давхар налуу, %-кодлол, trailing slash-аар тойрч болохгүй', () => {
    for (const p of ['/api/SCORING/Underwrite/preview', '/api/scoring//underwrite', '/api/scoring/%75nderwrite/preview', '/api/scoring/sosco/%73core', '/api/scoring/sosco/results/', '/api/scoring/sosco//Results/latest', '/api/scoring/underwrite/']) {
      expect(isInternalOnly(p), p).toBe(true);
    }
  });
  it('задлагдахгүй зам (буруу %-кодлол) нь дамжихгүй', () => {
    expect(isInternalOnly('/api/scoring/sosco/%E0%A4%A')).toBe(true);
  });
  it('sosco/models ба bsa нээлттэй хэвээр (эрхийг route-policy / сервис шалгана)', () => {
    for (const p of ['/api/scoring/sosco/models', '/api/scoring/sosco/models/active', '/api/scoring/bsa', '/api/scoring/bsa/analyses/a-1', '/api/scoring/bsa/categories', '/api/scoring/health', '/api/scoring/sosco']) {
      expect(isInternalOnly(p), p).toBe(false);
    }
  });
  it('look-alike угтварыг дотоод гэж андуурахгүй', () => {
    for (const p of ['/api/scoring/underwriter', '/api/scoring/underwrite-x', '/api/scoring/sosco/scores', '/api/scoring/sosco/results-archive', '/api/scoring/sosco/scoreboard']) {
      expect(isInternalOnly(p), p).toBe(false);
    }
  });
  it('sosco/models: унших нь эрх шаардахгүй, засах нь settings:manage; bsa-ийн дүрэм өөрчлөгдөөгүй', () => {
    expect(requiredPermission('GET', '/api/scoring/sosco/models')).toBeNull();
    expect(requiredPermission('PUT', '/api/scoring/sosco/models')).toBe('settings:manage');
    expect(requiredPermission('PUT', '/api/scoring/bsa/rules')).toBe('settings:manage');
    expect(requiredPermission('POST', '/api/scoring/bsa/analyses')).toBeNull();
  });
});

describe('isAmbiguousPath (NFR-3: шалгасан зам = дамжуулсан зам)', () => {
  it('http-proxy-ийн нормчлолоор өөр зам болох хэлбэрүүдийг хаана (INTERNAL_ONLY / эрхийн шалгалтыг тойрох оролдлого)', () => {
    for (const p of [
      '/api/scoring/underwrite\\applications/APP1/latest', '/api/scoring/underwrite\\', '/api/scoring/sosco\\score', '/api/scoring/sosco/results\\latest',
      '/api/scoring/underwrite%5Capplications/x', '/api/scoring/underwrite%5c', '/api/scoring/underwrite%2Fpreview', '/api/scoring//underwrite/preview',
      '/api/scoring/sosco/./score', '/api/scoring/sosco/x/../score', '/api/scoring/sosco/%2e%2e/score', '/api/scoring/sosco;x/score', '/api/scoring/sosco/score%00', '/api/scoring/sosco/score\u0000',
    ]) expect(isAmbiguousPath(p), p).toBe(true);
  });

  it('жирийн API замуудыг (id, шимтгэл, кирилл эсвэл %-кодлосон үсэг) хаахгүй', () => {
    for (const p of [
      '/api/origination/applications/00000000-0000-4000-8000-000000000001/score/calculate', '/api/scoring/sosco/models/active', '/api/scoring/bsa/categories/', '/api/dms/files/a%20b',
      '/api/origination/customers/%D0%91%D0%B0%D1%82', '/api/scoring/underwrite', '/api/valuation/base-prices',
    ]) expect(isAmbiguousPath(p), p).toBe(false);
  });
});

describe('isInternalOnly (staff proxy blocks internal sync paths)', () => {
  it('Module 6/9: documents are created only through origination; collateral valuations are saved only by origination', () => {
    expect(isInternalOnly('/api/dms/documents')).toBe(true);
    expect(isInternalOnly('/api/dms/documents/abc')).toBe(true);
    expect(isInternalOnly('/api/DMS/Documents/abc')).toBe(true);
    expect(isInternalOnly('/api/valuation/valuate/collateral/suggest')).toBe(true);
    expect(isInternalOnly('/api/valuation/valuate/collateral')).toBe(true);
    // бусдын регистр/нэр буцаадаг лавлагаа: origination л дуудна
    for (const p of ['/api/kyc/xyp/assets', '/api/kyc/xyp/property', '/api/kyc/collateral-checks/encumbrance', '/api/valuation/valuate/vehicle-lookup']) expect(isInternalOnly(p)).toBe(true);
  });
  // ХУР-ын иргэний зөвшөөрөл (нэг удаагийн код): регистр тус бүрийн хязгаар (SMS бөмбөгдөлт, кодыг таах) ба аудит origination-д (`customers/xyp-otp`, `xyp-fetch`).
  // kyc-ийн замыг ажилтан шууд дуудвал эдгээр хамгаалалтыг тойрно.
  it('kyc /xyp/citizen ба /xyp/citizen/otp нь origination-ийн хязгаар, аудитыг тойрох боломжгүйн тулд ажилтанд хаалттай; origination-ийн замууд нээлттэй', () => {
    for (const p of ['/api/kyc/xyp/citizen', '/api/kyc/xyp/citizen/otp', '/api/KYC/XYP/Citizen/OTP', '/api/kyc//xyp/citizen/otp', '/api/kyc/xyp/citizen/']) expect(isInternalOnly(p), p).toBe(true);
    for (const p of ['/api/origination/customers/xyp-otp', '/api/origination/customers/xyp-fetch']) expect(isInternalOnly(p), p).toBe(false);
  });
  it('file upload, base prices and the owner-less auto-valuation stay open to staff', () => {
    expect(isInternalOnly('/api/dms/files')).toBe(false);
    expect(isInternalOnly('/api/dms/files/abc/content')).toBe(false);
    expect(isInternalOnly('/api/dms/documents-x')).toBe(false);
    expect(isInternalOnly('/api/valuation/valuate/auto')).toBe(false);
    expect(isInternalOnly('/api/valuation/base-prices')).toBe(false);
  });
});

describe('requiredPermission (M13 админ)', () => {
  it('гэрээний дугаарын загвар унших/бичих бүгд settings:manage', () => {
    expect(requiredPermission('GET', '/api/origination/contract-number-template')).toBe('settings:manage');
    expect(requiredPermission('PUT', '/api/origination/contract-number-template')).toBe('settings:manage');
  });
  it('аудит лог унших нь audit:read', () => {
    expect(requiredPermission('GET', '/api/origination/audit-logs')).toBe('audit:read');
  });
});

describe('PUBLIC_PAYMENT_CALLBACKS (H9)', () => {
  it('opens exactly the three provider callback routes and nothing else', () => {
    expect(PUBLIC_PAYMENT_CALLBACKS.map((r) => `${r.method} ${r.path} -> ${r.upstreamPath}`)).toEqual([
      'GET /api/origination/payments/callbacks/qpay -> /api/payments/callbacks/qpay',
      'POST /api/origination/payments/callbacks/qpay -> /api/payments/callbacks/qpay',
      'POST /api/origination/payments/callbacks/socialpay -> /api/payments/callbacks/socialpay',
    ]);
  });
});

describe('ROUTE_POLICIES (NFR-3 drift guard coverage)', () => {
  it('every policy service has a route-authorization test that compares it with the service controllers', () => {
    const services = [...new Set(ROUTE_POLICIES.map((p) => p.service))];
    const testFile = (s: string) => resolve(__dirname, `../../../../${s}/test/route-authorization.test.ts`);
    const missing = services.filter((s) => !existsSync(testFile(s)) || !readFileSync(testFile(s), 'utf8').includes('findPolicyDrift'));
    expect(missing).toEqual([]);
  });
});
