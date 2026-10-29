import { describe, expect, it } from 'vitest';
import { sanitizeRaw } from '../../integrations/payment-provider/sanitize';

describe('sanitizeRaw (brief §8: токен, нууц үг, PII)', () => {
  it('нууц түлхүүрүүдийг хасна (гүн түвшинд ч)', () => {
    const out = sanitizeRaw({ ok: 1, access_token: 'A', nested: { Password: 'P', client_secret: 'S', Authorization: 'Bearer x', list: [{ api_key: 'K', keep: 'y' }] } });
    expect(out).toEqual({ ok: 1, nested: { list: [{ keep: 'y' }] } });
  });

  it('дансны дугаар, утас зэргийг нуугдмал болгоно', () => {
    const out = sanitizeRaw({ payer_account: '5012345678', paid_by: 'P2P', phone: '99112233', amount: 1000, description: 'LOS-1' }) as Record<string, unknown>;
    expect(out.payer_account).toBe('******5678');
    expect(out.phone).toBe('****2233');
    expect(out.paid_by).toBe('***'); // ≤ 4 тэмдэгттэй утга бүрэн нуугдана
    expect(out.amount).toBe(1000);
    expect(out.description).toBe('LOS-1');
  });

  it('массив 50 элементээр, гүн 6 түвшнээр хязгаарлагдана; примитив хэвээр', () => {
    expect((sanitizeRaw(Array.from({ length: 80 }, (_, i) => i)) as number[]).length).toBe(50);
    expect(sanitizeRaw('x')).toBe('x');
    expect(sanitizeRaw(null)).toBeNull();
    let deep: unknown = 'end';
    for (let i = 0; i < 10; i++) deep = { a: deep };
    expect(JSON.stringify(sanitizeRaw(deep))).toContain('[truncated]');
  });
});
