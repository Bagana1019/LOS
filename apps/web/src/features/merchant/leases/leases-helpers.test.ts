import { PosQuoteRequest } from '@los/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeLease } from '../../../../e2e/fixtures';
import { DEFAULT_PAGE_SIZE, filtersToParams, filtersToSearch, hasActiveFilters, parseLeaseFilters, type LeaseFilters } from './filters';
import { buildRetryHref, parsePrefill } from './prefill';
import { buildQuoteRequest, downPaymentShortcut } from './quote-request';
import { clearBuyerDrafts, forgetBuyer, peekBuyer, rememberBuyer } from './retry-draft';

const STORE = '22222222-2222-4222-8222-222222222222';
const sp = (q: string) => new URLSearchParams(q);

describe('lease list filters <-> URL', () => {
  it('defaults', () => {
    const f = parseLeaseFilters(sp(''));
    expect(f).toEqual({ status: [], page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(hasActiveFilters(f)).toBe(false);
    expect(filtersToSearch(f)).toBe('');
  });
  it('parses every filter', () => {
    const f = parseLeaseFilters(sp(`status=APPROVED,REFERRED&store=${STORE}&from=2026-10-01&to=2026-10-28&page=3&pageSize=50`));
    expect(f).toEqual({ status: ['APPROVED', 'REFERRED'], storeId: STORE, from: '2026-10-01', to: '2026-10-28', page: 3, pageSize: 50 });
    expect(hasActiveFilters(f)).toBe(true);
  });
  it('ignores invalid values instead of passing them to the API', () => {
    const f = parseLeaseFilters(sp('status=APPROVED,BOGUS,APPROVED&store=not-a-uuid&from=2026-13&to=tomorrow&page=0&pageSize=7'));
    expect(f).toEqual({ status: ['APPROVED'], page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(parseLeaseFilters(sp('page=-2')).page).toBe(1);
    expect(parseLeaseFilters(sp('page=1.5')).page).toBe(1);
    expect(parseLeaseFilters(sp('page=abc')).page).toBe(1);
  });
  it('round-trips and omits defaults', () => {
    const f: LeaseFilters = { status: ['DELIVERED', 'SETTLED'], storeId: STORE, from: '2026-10-01', page: 2, pageSize: 10 };
    const search = filtersToSearch(f);
    expect(search.startsWith('?')).toBe(true);
    expect(parseLeaseFilters(sp(search.slice(1)))).toEqual(f);
    expect(filtersToSearch({ status: [], page: 1, pageSize: 20 })).toBe('');
    expect(filtersToSearch({ status: [], page: 1, pageSize: 50 })).toBe('?pageSize=50');
  });
  // n=7: хайлтын текст бүтэн регистр/утасны цифр байж болно (POS-FR-8) → хөтчийн түүх, access log, хуваалцсан холбоосонд ОРОХГҮЙ (POS-BR-7).
  it('never writes the search text (register / phone digits) into the page URL', () => {
    for (const q of ['УЕ90050100', '99112233', '0007', 'iphone']) {
      const search = filtersToSearch({ status: ['APPROVED'], q, page: 2, pageSize: 20 });
      expect(search).toBe('?status=APPROVED&page=2');
      expect(search).not.toContain(q);
      expect(decodeURIComponent(search)).not.toContain(q);
    }
    expect(filtersToSearch({ status: [], q: 'УЕ90050100', page: 1, pageSize: 20 })).toBe('');
  });
  it('ignores a q in an old/shared URL instead of re-applying it', () => {
    const f = parseLeaseFilters(sp('q=УЕ90050100&status=DRAFT'));
    expect(f).toEqual({ status: ['DRAFT'], page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(f).not.toHaveProperty('q');
  });
  it('still sends q to the API (component state -> params) and counts it as an active filter', () => {
    expect(filtersToParams({ status: [], q: 'УЕ90050100', page: 1, pageSize: 20 })).toEqual({ q: 'УЕ90050100', page: 1, pageSize: 20 });
    expect(hasActiveFilters({ status: [], q: '0007', page: 1, pageSize: 20 })).toBe(true);
  });
  it('converts to API params with UB day edges', () => {
    const p = filtersToParams({ status: ['DRAFT'], storeId: STORE, q: 'x', from: '2026-10-01', to: '2026-10-28', page: 2, pageSize: 20 });
    expect(p).toEqual({ status: ['DRAFT'], storeId: STORE, q: 'x', from: '2026-10-01T00:00:00+08:00', to: '2026-10-28T23:59:59.999+08:00', page: 2, pageSize: 20 });
    expect(filtersToParams({ status: [], page: 1, pageSize: 20 })).toEqual({ page: 1, pageSize: 20 });
  });
});

describe('retry prefill (DECLINED -> raise the down payment)', () => {
  it('parsePrefill reads known fields only and sanitises them', () => {
    const p = parsePrefill(sp('retryOf=abc&planCode=laptop&category=COMPUTER&goods=Lenovo+IdeaPad&price=1500000&term=12&down=900000'));
    expect(p).toEqual({ retryOf: 'abc', planCode: 'LAPTOP', category: 'COMPUTER', goodsName: 'Lenovo IdeaPad', price: 1_500_000, termMonths: 12, downPayment: 900_000 });
  });
  it('drops invalid numbers and unknown categories', () => {
    const p = parsePrefill(sp('category=WEAPONS&price=-5&down=abc&term=1.5&goods='));
    expect(p).toEqual({});
    expect(parsePrefill(sp('term=0'))).toEqual({});
    expect(parsePrefill(sp('down=0'))).toEqual({ downPayment: 0 });
  });
  it('caps the goods name length', () => {
    expect(parsePrefill(sp(`goods=${'я'.repeat(500)}`)).goodsName).toHaveLength(200);
  });
  it('buildRetryHref uses the suggested down payment and never carries buyer PII', () => {
    const lease = makeLease({ status: 'DECLINED', price: 1_500_000, down: 450_000, term: 12 });
    const href = buildRetryHref(lease, 900_000);
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/merchant/leases/new');
    expect(url.searchParams.get('retryOf')).toBe(lease.id);
    expect(url.searchParams.get('down')).toBe('900000');
    expect(url.searchParams.get('price')).toBe('1500000');
    expect(url.searchParams.get('term')).toBe('12');
    expect(url.searchParams.get('planCode')).toBe('LAPTOP');
    expect(href).not.toMatch(/УЕ|register|phone|99\*/i);
    // Санал болгосон дүн байхгүй бол одоогийн урьдчилгаа
    expect(new URL(buildRetryHref(lease), 'http://x').searchParams.get('down')).toBe('450000');
    expect(new URL(buildRetryHref(lease, null), 'http://x').searchParams.get('down')).toBe('450000');
    // round trip
    expect(parsePrefill(url.searchParams)).toMatchObject({ retryOf: lease.id, planCode: 'LAPTOP', downPayment: 900_000, price: 1_500_000, termMonths: 12, category: 'COMPUTER' });
  });
});

describe('quote request builder', () => {
  const base = { planCode: 'LAPTOP', category: 'COMPUTER' as const, price: 1_500_000, downPayment: 300_000, termMonths: 12 };
  it('builds a contract-valid request', () => {
    const r = buildQuoteRequest(base);
    expect(r).toEqual({ planCode: 'LAPTOP', goodsPrice: 1_500_000, downPayment: 300_000, termMonths: 12, goodsCategory: 'COMPUTER' });
    expect(PosQuoteRequest.safeParse(r).success).toBe(true);
    expect(buildQuoteRequest({ ...base, category: undefined })).not.toHaveProperty('goodsCategory');
  });
  it('returns null until the input is complete and sane (no request per keystroke)', () => {
    expect(buildQuoteRequest({})).toBeNull();
    expect(buildQuoteRequest({ ...base, planCode: undefined })).toBeNull();
    expect(buildQuoteRequest({ ...base, termMonths: undefined })).toBeNull();
    expect(buildQuoteRequest({ ...base, price: null })).toBeNull();
    expect(buildQuoteRequest({ ...base, price: 0 })).toBeNull();
    expect(buildQuoteRequest({ ...base, downPayment: null })).toBeNull();
    expect(buildQuoteRequest({ ...base, downPayment: -1 })).toBeNull();
    expect(buildQuoteRequest({ ...base, downPayment: 1_500_000 })).toBeNull();
    expect(buildQuoteRequest({ ...base, downPayment: 0 })).not.toBeNull();
  });
  it('down payment shortcuts are plain whole-tugrik input helpers', () => {
    expect(downPaymentShortcut(1_500_000, 30)).toBe(450_000);
    expect(downPaymentShortcut(1_500_000, 20)).toBe(300_000);
    expect(downPaymentShortcut(999_999, 50)).toBe(500_000);
    expect(Number.isInteger(downPaymentShortcut(1_234_567, 30))).toBe(true);
  });
});

describe('retry draft (buyer PII lives only in memory)', () => {
  beforeEach(() => clearBuyerDrafts());
  it('remembers, peeks and forgets', () => {
    rememberBuyer('l1', { registerNo: 'УБ12345678', phone: '99112233' });
    expect(peekBuyer('l1')).toEqual({ registerNo: 'УБ12345678', phone: '99112233' });
    expect(peekBuyer('l2')).toBeUndefined();
    expect(peekBuyer(undefined)).toBeUndefined();
    forgetBuyer('l1');
    expect(peekBuyer('l1')).toBeUndefined();
  });
  it('stores a copy, not the caller object', () => {
    const b = { registerNo: 'УБ12345678', phone: '99112233' };
    rememberBuyer('l1', b);
    b.phone = '00000000';
    expect(peekBuyer('l1')!.phone).toBe('99112233');
  });
  it('keeps at most 5 entries (oldest evicted)', () => {
    for (let i = 1; i <= 7; i++) rememberBuyer(`l${i}`, { registerNo: 'УБ12345678', phone: '99112233' });
    expect(peekBuyer('l1')).toBeUndefined();
    expect(peekBuyer('l2')).toBeUndefined();
    expect(peekBuyer('l3')).toBeDefined();
    expect(peekBuyer('l7')).toBeDefined();
  });
  it('never touches web storage', () => {
    const touched: string[] = [];
    const storage = new Proxy({}, { get: (_t, p) => { touched.push(String(p)); return () => null; } });
    (globalThis as Record<string, unknown>).localStorage = storage;
    (globalThis as Record<string, unknown>).sessionStorage = storage;
    rememberBuyer('l1', { registerNo: 'УБ12345678', phone: '99112233' });
    peekBuyer('l1');
    forgetBuyer('l1');
    delete (globalThis as Record<string, unknown>).localStorage;
    delete (globalThis as Record<string, unknown>).sessionStorage;
    expect(touched).toEqual([]);
  });
});
