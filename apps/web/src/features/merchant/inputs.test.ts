import { describe, expect, it } from 'vitest';
import { mntFormatter, mntParser } from './inputs';

// n=32: '2,000,000.00' нь 200,000,000 болж (100 дахин) алдаж байсан.
describe('mntParser (money paste/typing)', () => {
  it('drops the decimal part instead of concatenating it into the integer', () => {
    expect(mntParser('2,000,000.00')).toBe('2000000');
    expect(mntParser('2000000.5')).toBe('2000000');
    expect(mntParser('2000000.00')).toBe('2000000');
    expect(mntParser('1500.5')).toBe('1500');
    expect(mntParser('12.')).toBe('12');
    expect(mntParser('0.99')).toBe('0');
  });
  it('strips thousands separators and spaces', () => {
    expect(mntParser('2 000 000')).toBe('2000000');
    expect(mntParser('2 000 000')).toBe('2000000');
    expect(mntParser('2,000,000')).toBe('2000000');
    expect(mntParser("2'000'000")).toBe('2000000');
    expect(mntParser('2000000')).toBe('2000000');
    expect(mntParser('1,500')).toBe('1500');
  });
  it('handles the European style too (dot groups, decimal comma) without 100x errors', () => {
    expect(mntParser('2.000.000')).toBe('2000000');
    expect(mntParser('2.000.000,00')).toBe('2000000');
    expect(mntParser('2000000,5')).toBe('2000000');
  });
  it('typing keystroke by keystroke never inflates the number', () => {
    // antd нь талбарын ЭЦСИЙН бүтэн текстийг parser-т өгдөг: "1,500" + "." + "5"
    expect(mntParser('1,500.')).toBe('1500');
    expect(mntParser('1,500.5')).toBe('1500');
  });
  it('removes currency signs and letters; garbage and empty become empty', () => {
    expect(mntParser('₮1,500₮')).toBe('1500');
    expect(mntParser('1500 MNT')).toBe('1500');
    expect(mntParser('abc')).toBe('');
    expect(mntParser('')).toBe('');
    expect(mntParser('.')).toBe('');
    expect(mntParser('.5')).toBe('');
    expect(mntParser('-')).toBe('');
    expect(mntParser(undefined)).toBe('');
    expect(mntParser(null)).toBe('');
  });
  it('keeps a negative sign so the min rule reports it (never silently flips -1,500 to 1500)', () => {
    expect(mntParser('-1,500')).toBe('-1500');
    expect(mntParser('−5')).toBe('-5');
  });
  it('round-trips with the formatter', () => {
    expect(mntFormatter(mntParser('2,000,000.00'))).toBe('2,000,000');
    expect(mntFormatter(2000000)).toBe('2,000,000');
    expect(mntFormatter(undefined)).toBe('');
    expect(mntFormatter('')).toBe('');
  });
});
