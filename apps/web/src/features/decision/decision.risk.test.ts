import { describe, expect, it } from 'vitest';
import type { DecisionView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { formatRatioLimit, formatRatioValue, methodLabel, progressCounts } from './decision.risk';

// F3-1: шийдвэрийн хуудасны «8/8» шугам ба зүүн самбарын «Бүрдсэн: 9/9» нэг тоог харуулах ёстой; хоёр тоолуур юуг тоолж буйгаа хэлнэ.
// Шалтгаан: шугам нь заавал бүрдэх (BR-7) 8 алхмыг, самбар нь 1-р үе шатны 9 алхмыг (шийдвэр алхам өөрөө орно) тоолдог байсан.
describe('progressCounts (F3-1)', () => {
  const required: DecisionView['progress'] = { completed: 8, total: 8, missing: [], reasons: {} };

  it('wizard-ийн тоолуур байвал шугам ТЭРТЭЙ ижил тоог (9/9) харуулна; заавал бүрдэхийг (8/8) тусад нь нэрлэнэ', () => {
    const c = progressCounts(required, { completed: 9, total: 9 });
    expect([c.done, c.total, c.percent]).toEqual([9, 9, 100]);
    // самбар: t('application.wizard.counter') = «Бүрдсэн: 9/9» — шугамын тоо ижил
    expect(t('application.wizard.counter', { done: 9, total: 9 })).toContain(`${c.done}/${c.total}`);
    expect(c.label).toContain('9/9');
    expect(c.requiredLabel).toContain('8/8');
  });

  it('шугамын тоо (done/total) самбартай үргэлж ижил: 8/9 ба заавал бүрдэх 8/8 (шийдвэр алхам хараахан бүрдээгүй)', () => {
    const c = progressCounts(required, { completed: 8, total: 9 });
    expect([c.done, c.total, c.percent]).toEqual([8, 9, 89]);
    expect(c.requiredLabel).toContain('8/8');
  });

  it('wizard-ийн тоолуур байхгүй (ачаалаагүй) бол заавал бүрдэх алхмаар; тайлбар нь юу тоолж буйгаа хэлнэ, давхар мөр нэмэхгүй', () => {
    const c = progressCounts({ ...required, completed: 5, total: 8, missing: ['income'] }, null);
    expect([c.done, c.total, c.percent]).toEqual([5, 8, 63]);
    expect(c.label).toBe(t('decide.progress.required', { done: 5, total: 8 }));
    expect(c.requiredLabel).toBeNull();
  });

  it('нийт 0 бол 0% (хуваагдахгүй)', () => {
    expect(progressCounts({ completed: 0, total: 0, missing: [], reasons: {} }, null).percent).toBe(0);
    expect(progressCounts(required, { completed: 0, total: 0 }).percent).toBe(0);
  });
});

describe('methodLabel (F3-1: «A_SALARY» гэсэн түүхий enum харуулахгүй)', () => {
  it('score-ийн монгол шошгыг ашиглана', () => {
    expect(methodLabel('A_SALARY')).toBe('A · Цалин');
    expect(methodLabel('B_BUSINESS')).toBe('B · Бизнес');
    expect(methodLabel('C_COMBINED')).toBe('C · Хосолсон');
  });
  it('мэдэгдэхгүй код хэвээр, байхгүй бол «—»', () => {
    expect(methodLabel('X_NEW')).toBe('X_NEW');
    expect(methodLabel(null)).toBe('—');
    expect(methodLabel(undefined)).toBe('—');
  });
});

describe('харьцааны текст (зөвхөн формат; тооцоолол биш)', () => {
  it('ӨОХ бутархай → %, ӨТЧХ харьцаа 2 оронтой', () => {
    expect(formatRatioValue('DTI', 0.4321)).toBe('43.21%');
    expect(formatRatioValue('DSCR', 1.8)).toBe('1.80');
    expect(formatRatioValue('DTI', null)).toBe('—');
  });
  it('ӨОХ-д дээд, ӨТЧХ-д доод хязгаар', () => {
    expect(formatRatioLimit('DTI', 0.55)).toBe(t('decide.risk.limitMax', { value: '55%' }));
    expect(formatRatioLimit('DSCR', 1.25)).toBe(t('decide.risk.limitMin', { value: '1.25' }));
    expect(formatRatioLimit('DTI', null)).toBe('');
  });
});
