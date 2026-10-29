import { describe, expect, it } from 'vitest';
import { encryptedField } from '@los/database';
import { convertValue, fullName, maskedRegister, round, toNumber } from './report-values';

describe('report-values', () => {
  it('round: хагас дээш (хөвөгч таслалын алдаагүй), сөрөг', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(0.1 + 0.2, 2)).toBe(0.3);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(0.5816733, 6)).toBe(0.581673);
    expect(round(0, 2)).toBe(0);
  });

  it('toNumber: bigint, Decimal-ийн string, number; хоосон/буруу → null', () => {
    expect(toNumber(5n)).toBe(5);
    expect(toNumber('1234.50')).toBe(1234.5);
    expect(toNumber({ toString: () => '99.1' })).toBe(99.1); // Prisma Decimal
    expect(toNumber(7)).toBe(7);
    for (const v of [null, undefined, 'abc', NaN, Infinity]) expect(toNumber(v), String(v)).toBeNull();
  });

  it('convertValue: money 2 орон, percent 6 орон, number, string, boolean, null', () => {
    expect(convertValue('money', '1000.005')).toBe(1000.01);
    expect(convertValue('money', 12n)).toBe(12);
    expect(convertValue('percent', '0.58167312')).toBe(0.581673);
    expect(convertValue('number', '3')).toBe(3);
    expect(convertValue('string', 42)).toBe('42');
    expect(convertValue('status', 'ACTIVE')).toBe('ACTIVE');
    expect(convertValue('string', true)).toBe(true);
    expect(convertValue('date', '2026-10-28')).toBe('2026-10-28');
    expect(convertValue('money', null)).toBeNull();
    expect(convertValue('money', 'x')).toBeNull();
  });

  it('maskedRegister: шифрлэгдсэнийг тайлж нууцлана; муу өгөгдөлд null (тайланг унагахгүй)', () => {
    expect(maskedRegister(encryptedField('УБ99010112'))).toBe('УБ****0112');
    expect(maskedRegister('v1.garbage')).toBeNull();
    expect(maskedRegister('')).toBeNull();
    expect(maskedRegister(null)).toBeNull();
    expect(maskedRegister(123)).toBeNull();
  });

  it('fullName: овог нэр, хоосон хэсгийг алгасна', () => {
    expect(fullName('Бат', 'Болд')).toBe('Бат Болд');
    expect(fullName(' Бат ', null)).toBe('Бат');
    expect(fullName(null, 'Болд')).toBe('Болд');
    expect(fullName('', '  ')).toBeNull();
    expect(fullName(undefined, undefined)).toBeNull();
  });
});
