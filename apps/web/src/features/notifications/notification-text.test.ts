import { describe, expect, it } from 'vitest';
import { displayNotificationBody } from './notification-text';

// F3-5: мэдэгдлийн бичвэрт "20,000,000 MNT" биш, системийн бусад хэсэгтэй адил "20,000,000₮" харагдана (зөвхөн харуулалт; хадгалсан бичвэр өөрчлөгдөхгүй).

describe('displayNotificationBody', () => {
  it('shows an MNT amount with the ₮ sign, like formatMnt does elsewhere', () => {
    expect(displayNotificationBody('Хүсэлтийн 20,000,000 MNT олголт зөвшөөрөгдлөө.')).toBe('Хүсэлтийн 20,000,000₮ олголт зөвшөөрөгдлөө.');
  });

  it('keeps the Mongolian genitive suffix attached', () => {
    expect(displayNotificationBody('Таны 20,000,000 MNT-ийн зээлийн хүсэлт батлагдлаа.')).toBe('Таны 20,000,000₮-ийн зээлийн хүсэлт батлагдлаа.');
  });

  it.each([
    ['500 MNT', '500₮'],
    ['500MNT', '500₮'],
    ['1,200,000.50 MNT', '1,200,000.50₮'],
    ['0 MNT', '0₮'],
  ])('converts "%s" to "%s"', (input, expected) => {
    expect(displayNotificationBody(input)).toBe(expected);
  });

  it('converts every amount in a multi-line body and keeps the line breaks', () => {
    const body = 'Төлбөр 1,000,000 MNT.\nХэтэрсэн: 250,000 MNT.';
    expect(displayNotificationBody(body)).toBe('Төлбөр 1,000,000₮.\nХэтэрсэн: 250,000₮.');
  });

  it('leaves other currencies alone — the symbol is only right for MNT', () => {
    expect(displayNotificationBody('Төлбөр 1,000 USD.')).toBe('Төлбөр 1,000 USD.');
  });

  it('leaves MNT without a number, and words that merely contain MNT, alone', () => {
    expect(displayNotificationBody('Валют: MNT')).toBe('Валют: MNT');
    expect(displayNotificationBody('Код 100 MNTX')).toBe('Код 100 MNTX');
  });

  it('does not touch contract or application numbers', () => {
    const body = 'BZ-2026-000123 ба APP-2026-000123 дугаартай хүсэлт.';
    expect(displayNotificationBody(body)).toBe(body);
  });

  it('is idempotent and handles an empty body', () => {
    const once = displayNotificationBody('Дүн 20,000,000 MNT.');
    expect(displayNotificationBody(once)).toBe(once);
    expect(displayNotificationBody('')).toBe('');
  });
});
