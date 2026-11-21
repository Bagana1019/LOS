import { describe, expect, it } from 'vitest';
import { consumeCustomerCreated, markCustomerCreated } from './customer-created-flag';

const ID = '22222222-2222-4222-8222-222222222222';
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
};

describe('customer-created-flag', () => {
  it('бүртгэсний дараа карт нээгдэхэд нэг удаа true, дараа нь false (дахин нээхэд баннер гарахгүй)', () => {
    const s = memory();
    markCustomerCreated(ID, s);
    expect(consumeCustomerCreated(ID, s)).toBe(true);
    expect(consumeCustomerCreated(ID, s)).toBe(false);
  });

  it('өөр харилцагчийн карт нээхэд false, тэмдэг устахгүй', () => {
    const s = memory();
    markCustomerCreated(ID, s);
    expect(consumeCustomerCreated('99999999-9999-4999-8999-999999999999', s)).toBe(false);
    expect(s.size()).toBe(1);
  });

  it('хадгалалтгүй (SSR) эсвэл алдаа шиддэг хадгалалтад унахгүй, false', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => markCustomerCreated(ID, null)).not.toThrow();
    expect(() => markCustomerCreated(ID, broken)).not.toThrow();
    expect(consumeCustomerCreated(ID, null)).toBe(false);
    expect(consumeCustomerCreated(ID, broken)).toBe(false);
  });
});
