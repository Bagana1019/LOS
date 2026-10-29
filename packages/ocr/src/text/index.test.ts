import { describe, expect, it } from 'vitest';
import * as pkg from '../index';
import * as text from './index';

describe('public API of @los/ocr text utilities', () => {
  const functions = [
    'toMatchKey',
    'cyrillicToLatin',
    'foldLatinLookalikesToCyrillic',
    'normalizeWhitespace',
    'parseMnAmount',
    'parseDateIso',
    'findDates',
    'parseTime',
    'normalizeAccountNo',
    'isValidIban',
    'parseRegisterNo',
    'namesMatch',
    'maskForLog',
  ] as const;

  it.each(functions)('exports %s from the text barrel and from the package index', (name) => {
    expect(typeof text[name]).toBe('function');
    expect(pkg[name]).toBe(text[name]);
  });

  it('exports exactly the agreed runtime names from the text barrel (no accidental extras)', () => {
    expect(Object.keys(text).sort()).toEqual([...functions].sort());
  });

  it('keeps the existing OCR contract exports', () => {
    expect(typeof pkg.OcrError).toBe('function');
    expect(pkg.OCR_PDF_MIME_TYPE).toBe('application/pdf');
  });

  it('works end to end through the package entry point', () => {
    expect(pkg.toMatchKey('Цалин')).toBe(pkg.toMatchKey('tsalin'));
    expect(pkg.parseMnAmount('(1,000.00)')).toBe(-1000);
    expect(pkg.parseDateIso('2026 оны 3 дугаар сарын 10')).toBe('2026-03-10');
    expect(pkg.parseRegisterNo('УБ90010203').valid).toBe(true);
    expect(pkg.namesMatch('Б.Болд', 'Болд Батаа').match).toBe(true);
    expect(pkg.maskForLog('УБ90010203')).toBe('********03');
  });
});
