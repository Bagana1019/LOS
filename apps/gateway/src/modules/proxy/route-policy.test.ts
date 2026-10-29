import { describe, expect, it } from 'vitest';
import { isInternalOnly, requiredPermission } from './route-policy';

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
