import { describe, expect, it } from 'vitest';
import type { LeaseRecord } from '../../domain/records';
import { at, makeLease, makeMerchant, makePlan, makeQuote, makeStore, makeTimeline } from '../contract-fixtures';
import { Prisma } from './client';
import { actorParts, dec, decOrNull, leaseMutable, merchantMutable, merchantToCreate, num, planMutable, storeMutable, timelineToCreate, toJsonOrNull } from './mappers';
import { clampPage, escapeLike, isUuid, uniqueViolation, violates } from './prisma-errors';
import { uuidV7 } from './uuid7';

// DB шаардахгүй нэгж тестүүд: UUIDv7, Prisma алдааны туслахууд, mapper-ууд.

describe('uuidV7', () => {
  it('has the RFC 9562 version and variant bits and the canonical shape', () => {
    const id = uuidV7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('is strictly increasing, including within one millisecond and across a counter overflow', () => {
    const base = Date.now();
    const ids = Array.from({ length: 10_000 }, () => uuidV7(base));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });

  it('stays monotonic when the clock goes backwards', () => {
    const a = uuidV7(Date.now() + 5);
    const b = uuidV7(1);
    expect(b > a).toBe(true);
  });
});

describe('prisma-errors', () => {
  const p2002 = (meta: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test', meta });

  it('reads model and columns from a P2002 error', () => {
    const v = uniqueViolation(p2002({ modelName: 'PosLease', target: ['merchant_id', 'idempotency_key'] }));
    expect(v).toEqual({ model: 'PosLease', columns: ['merchant_id', 'idempotency_key'] });
    expect(violates(v, 'PosLease', 'idempotency_key')).toBe(true);
    expect(violates(v, 'PosLease', 'lease_no')).toBe(false);
    expect(violates(v, 'Merchant', 'idempotency_key')).toBe(false); // өөр модель (outbox гэх мэт) таарахгүй
  });

  it('accepts a constraint name string target and a missing model name', () => {
    const v = uniqueViolation(p2002({ target: 'pos_lease_lease_no_key' }));
    expect(v).toEqual({ model: null, columns: ['pos_lease_lease_no_key'] });
    expect(violates(v, 'PosLease', 'lease_no')).toBe(true);
    expect(violates(uniqueViolation(p2002({})), 'PosLease', 'lease_no')).toBe(false);
  });

  it('ignores other Prisma codes and non-Prisma errors', () => {
    expect(uniqueViolation(new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }))).toBeNull();
    expect(uniqueViolation(new Error('boom'))).toBeNull();
    expect(uniqueViolation(undefined)).toBeNull();
    expect(violates(null, 'PosLease', 'lease_no')).toBe(false);
  });

  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(escapeLike('plain')).toBe('plain');
  });

  it('recognises canonical uuids only', () => {
    expect(isUuid('5f1d3a2b-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('5F1D3A2B-0000-4000-8000-000000000001')).toBe(true);
    for (const bad of ['', 'nope', '5f1d3a2b00004000800000000000000', undefined, null]) expect(isUuid(bad as string | undefined | null)).toBe(false);
  });

  it('clamps pagination to non-negative skip/take', () => {
    expect(clampPage({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
    expect(clampPage({ page: 0, pageSize: 20 })).toEqual({ skip: 0, take: 20 });
    expect(clampPage({ page: 1, pageSize: -5 })).toEqual({ skip: 0, take: 0 });
  });
});

describe('mappers', () => {
  it('converts numbers to exact decimals and back, refusing non-finite values', () => {
    expect(dec(0.1).toString()).toBe('0.1');
    expect(dec(1234567.89).toString()).toBe('1234567.89');
    expect(num(new Prisma.Decimal('2037000.48'))).toBe(2037000.48);
    expect(decOrNull(null)).toBeNull();
    expect(decOrNull(5)!.toString()).toBe('5');
    for (const bad of [NaN, Infinity, -Infinity]) expect(() => dec(bad)).toThrow(RangeError);
  });

  it('maps JS null to SQL NULL for optional JSON columns', () => {
    expect(toJsonOrNull(null)).toBe(Prisma.DbNull);
    expect(toJsonOrNull(undefined)).toBe(Prisma.DbNull);
    expect(toJsonOrNull({ a: 1 })).toEqual({ a: 1 });
    expect(toJsonOrNull([])).toEqual([]);
  });

  it('splits actors into id and label', () => {
    expect(actorParts('SYSTEM')).toEqual({ actorId: null, actorLabel: 'SYSTEM' });
    expect(actorParts('BUYER')).toEqual({ actorId: null, actorLabel: 'BUYER' });
    expect(actorParts('MERCHANT:user-1')).toEqual({ actorId: 'user-1', actorLabel: 'MERCHANT:user-1' });
    expect(actorParts('LENDER:a:b')).toEqual({ actorId: 'a:b', actorLabel: 'LENDER:a:b' });
    expect(actorParts('MERCHANT:')).toEqual({ actorId: null, actorLabel: 'MERCHANT:' });
  });

  it('never rewrites identity columns on update (id, orgId, createdAt, createdBy)', () => {
    const identity = ['id', 'orgId', 'createdAt', 'createdBy'];
    const m = makeMerchant();
    const refs = { merchantId: m.id, storeId: 's', planId: 'p' };
    for (const data of [merchantMutable(m), storeMutable(makeStore(m.id)), planMutable(makePlan()), leaseMutable(makeLease(refs))]) {
      for (const k of identity) expect(Object.keys(data)).not.toContain(k);
    }
    expect(Object.keys(merchantToCreate(m))).toEqual(expect.arrayContaining(identity));
  });

  it('derives the denormalised money columns from the quote snapshot', () => {
    const quote = makeQuote({ downPayment: 1.1, financedAmount: 2.2, feeAmount: 3.3, principal: 4.4, termMonths: 7, annualRate: 0.12, monthlyPayment: 5.5, merchantCommissionAmount: 6.6, merchantNetAmount: 7.7 });
    const data = leaseMutable({ ...makeLease({ merchantId: 'm', storeId: 's', planId: 'p' }), quote, goodsPrice: 9.9 } as LeaseRecord);
    expect([data.downPayment, data.financedAmount, data.feeAmount, data.principal, data.annualRate, data.monthlyPayment, data.merchantCommissionAmount, data.merchantNetAmount, data.goodsPrice].map(String))
      .toEqual(['1.1', '2.2', '3.3', '4.4', '0.12', '5.5', '6.6', '7.7', '9.9']);
    expect(data.termMonths).toBe(7);
    expect(data.quoteJson).toEqual(quote);
  });

  it('builds timeline rows with the lease org, a time-ordered id and SQL NULL data', () => {
    const lease = { id: '5f1d3a2b-0000-4000-8000-000000000001', orgId: 'org-x' };
    const row = timelineToCreate(lease, makeTimeline(lease.id, { at: at(3), actor: 'LENDER:u1', data: null }));
    expect(row).toMatchObject({ orgId: 'org-x', leaseId: lease.id, at: at(3), actorId: 'u1', actorLabel: 'LENDER:u1', dataJson: Prisma.DbNull });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
