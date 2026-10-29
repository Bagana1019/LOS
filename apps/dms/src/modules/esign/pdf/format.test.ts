import { describe, expect, it } from 'vitest';
import { formatUlaanbaatar, groupVerificationCode, mm } from './format';

describe('formatUlaanbaatar', () => {
  it('UTC-г +8 цагаар шилжүүлж YYYY-MM-DD HH:mm:ss гаргана', () => {
    expect(formatUlaanbaatar(new Date('2026-10-28T03:15:42.999Z'))).toBe('2026-10-28 11:15:42');
  });

  it('өдөр/жил дамжин шилжихэд зөв (UTC 16:00 = дараагийн өдрийн 00:00)', () => {
    expect(formatUlaanbaatar(new Date('2026-12-31T16:30:00Z'))).toBe('2027-01-01 00:30:00');
    expect(formatUlaanbaatar(new Date('2024-02-28T16:00:00Z'))).toBe('2024-02-29 00:00:00');
  });

  it('хугацаагүй гэрчилгээний notAfter (9999-12-31) гүйлгэж унахгүй', () => {
    expect(formatUlaanbaatar(new Date('9999-12-31T23:59:59Z'))).toBe('10000-01-01 07:59:59');
  });

  it('орчны цагийн бүсээс үл хамаарна (зуны цаг байхгүй, тогтмол +8)', () => {
    expect(formatUlaanbaatar(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01 08:00:00');
    expect(formatUlaanbaatar(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01 08:00:00');
  });
});

describe('groupVerificationCode', () => {
  it('12 тэмдэгтийг 4-өөр бүлэглэнэ', () => {
    expect(groupVerificationCode('7K3QXM9ZB4TN')).toBe('7K3Q-XM9Z-B4TN');
  });

  it('аль хэдийн бүлэглэсэн/жижиг үсэгтэйг нормчилно', () => {
    expect(groupVerificationCode('7k3q-xm9z-b4tn')).toBe('7K3Q-XM9Z-B4TN');
  });

  it('танигдахгүй тэмдэгт агуулсан бол өөрчлөхгүй', () => {
    expect(groupVerificationCode('AB CD/12')).toBe('AB CD/12');
  });
});

describe('mm', () => {
  it('25.4 мм = 72 pt', () => {
    expect(mm(25.4)).toBeCloseTo(72, 10);
    expect(mm(18)).toBeCloseTo(51.0236, 3);
  });
});
