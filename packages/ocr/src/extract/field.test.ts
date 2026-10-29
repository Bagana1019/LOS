import { describe, expect, it } from 'vitest';
import { combineConfidence, emptyField, makeField, titleCaseIfAllUpper } from './field';

describe('combineConfidence', () => {
  it('баталгаажсан → 1 рүү ойртоно; бүтэлгүйтсэн → буурна; шошгын алдаа торгоно; [0,1]-д хавчина', () => {
    expect(combineConfidence(0.8)).toBe(0.8);
    expect(combineConfidence(0.8, { validated: true })).toBe(0.9);
    expect(combineConfidence(0.8, { failed: true })).toBe(0.24);
    expect(combineConfidence(0.8, { labelDistance: 2 })).toBe(0.7);
    expect(combineConfidence(1, { heuristic: true })).toBe(0.85);
    expect(combineConfidence(1, { derived: true })).toBe(0.9);
    expect(combineConfidence(0.02, { labelDistance: 3 })).toBe(0);
    expect(combineConfidence(5)).toBe(1);
    expect(combineConfidence(-1)).toBe(0);
  });

  it('3 оронтой оноож', () => {
    expect(combineConfidence(1 / 3, { validated: true })).toBe(0.667);
  });
});

describe('makeField', () => {
  const s = { lowConfidenceThreshold: 0.6 };

  it('итгэл бага бол note-д анхааруулга нэмж, бусад note-той залгана', () => {
    const f = makeField({ value: 'x', raw: 'x', confidence: 0.4, notes: ['тайлбар', undefined] }, s);
    expect(f.note).toBe('тайлбар; Итгэл бага (40%) - гараар шалгана уу');
  });

  it('босго дээр (0.6) анхааруулга гарахгүй; утгагүй/хоосон массивд гарахгүй', () => {
    expect(makeField({ value: 'x', raw: null, confidence: 0.6 }, s).note).toBeUndefined();
    expect(makeField({ value: null, raw: null, confidence: 0.1 }, s).note).toBeUndefined();
    expect(makeField({ value: [], raw: null, confidence: 0.1 }, s).note).toBeUndefined();
    expect(makeField({ value: ['a'], raw: 'a', confidence: 0.1 }, s).note).toMatch(/Итгэл бага/);
  });

  it('alternatives зөвхөн хоосон биш үед', () => {
    expect(makeField({ value: 1, raw: null, confidence: 1, alternatives: [] }, s)).not.toHaveProperty('alternatives');
    expect(makeField({ value: 1, raw: null, confidence: 1, alternatives: [2] }, s).alternatives).toEqual([2]);
  });

  it('emptyField', () => {
    expect(emptyField()).toEqual({ value: null, confidence: 0, raw: null });
    expect(emptyField('Олдсонгүй')).toEqual({ value: null, confidence: 0, raw: null, note: 'Олдсонгүй' });
  });
});

describe('titleCaseIfAllUpper', () => {
  it('зөвхөн бүтэн том үсэгтэй үгийг; зураастай нэрийн хэсэг бүрийг', () => {
    expect(titleCaseIfAllUpper('ДОРЖ')).toBe('Дорж');
    expect(titleCaseIfAllUpper('БАТ-ЭРДЭНЭ')).toBe('Бат-Эрдэнэ');
    expect(titleCaseIfAllUpper('Дорж')).toBe('Дорж');
    expect(titleCaseIfAllUpper('Б')).toBe('Б');
    expect(titleCaseIfAllUpper('ДоРЖ')).toBe('ДоРЖ');
    expect(titleCaseIfAllUpper('123')).toBe('123');
  });
});
