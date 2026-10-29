import { describe, expect, it } from 'vitest';
import { LEGAL_FORMS, isLegalFormToken, normalizeEntityName } from './legal-forms';
import { nameSimilarity } from './name-similarity';
import { normalizeName } from './normalize';

const entity = { legalEntity: true };

describe('legal forms', () => {
  it('recognises every listed form after normalisation (ХХК and ХК both normalise to "hk")', () => {
    for (const form of LEGAL_FORMS) expect(isLegalFormToken(normalizeName(form)), form).toBe(true);
    expect(normalizeName('ХХК')).toBe(normalizeName('ХК'));
  });

  it.each([
    'ХХК', 'ХК', 'ТӨҮГ', 'ББСБ', 'LLC', 'Ltd', 'Limited', 'Co', 'Company', 'Inc', 'Corp', 'JSC', 'PLC', 'GmbH',
  ])('%s is a legal form', (form) => {
    expect(isLegalFormToken(normalizeName(form))).toBe(true);
  });

  it('does not treat meaningful words, initials or digits as legal forms', () => {
    for (const word of ['trading', 'holdings', 'bank', 'mongol', 'o', 'a', '88', 'hhkk', 'altan']) {
      expect(isLegalFormToken(word), word).toBe(false);
    }
  });

  it('is a small constant list', () => {
    expect(LEGAL_FORMS.length).toBeLessThanOrEqual(30);
  });

  // docs/05-ийн жагсаалт: нэг мөр устгавал энд бүтэлгүйтнэ (ХХК/ХК хоёр нэг "hk" болдог тул нэгийг нь устгавал өөр өөрчлөлт гарахгүй)
  it('lists every documented form, including the Russian and South Asian ones', () => {
    expect([...LEGAL_FORMS].sort()).toEqual([
      'ББСБ', 'CJSC', 'Co', 'Company', 'Corp', 'Corporation', 'FZC', 'FZCO', 'FZE', 'GmbH', 'Inc', 'Incorporated', 'JSC', 'LLC', 'LLP', 'Limited', 'Ltd',
      'ОАО', 'ОНӨААТҮГ', 'OJSC', 'PJSC', 'PLC', 'Pvt', 'SARL', 'SRL', 'ТӨҮГ', 'ХК', 'ХХК', 'ЗАО',
    ].sort());
  });

  describe.each(LEGAL_FORMS.map((form) => [form]))('%s', (form) => {
    it('is stripped from an entity name on either side', () => {
      expect(nameSimilarity(`Altanvex Trading ${form}`, 'Altanvex Trading', entity)).toBe(1);
      expect(nameSimilarity('Altanvex Trading', `${form} Altanvex Trading`, entity)).toBe(1);
    });

    it('is stripped when written with dots, one letter at a time (review [6])', () => {
      const dotted = `${[...form].join('.')}.`;
      expect(nameSimilarity(`Altanvex Trading ${dotted}`, 'Altanvex Trading', entity), dotted).toBe(1);
      const spaced = `${[...form].join('. ')}.`;
      expect(nameSimilarity(`Altanvex Trading ${spaced}`, 'Altanvex Trading', entity), spaced).toBe(1);
    });

    it('is an ordinary word for a person', () => {
      expect(nameSimilarity(`Altanvex Trading ${form}`, 'Altanvex Trading')).toBeLessThan(1);
    });
  });
});

describe('normalizeEntityName', () => {
  it.each([
    ['Al Noor Trading L.L.C.', 'Al Noor Trading LLC'],
    ['Zorya Shipping F.Z.E.', 'Zorya Shipping FZE'],
    ['Zorya Shipping P.J.S.C.', 'Zorya Shipping PJSC'],
    ['Zorya S.A.R.L.', 'Zorya SARL'],
    ['Алтан Х.Х.К', 'Алтан ХХК'],
    ['Алтан Х. Х. К.', 'Алтан ХХК'],
    ['Altan L. L. C', 'Altan LLC'],
    ['L.L.C. Altan', 'LLC Altan'],
  ])('collapses dotted single letters: %s', (input, expected) => {
    expect(normalizeEntityName(input)).toBe(expected);
  });

  it('leaves ordinary dots and initials followed by a word alone', () => {
    for (const input of ['A. Noor', 'Mr. A. Smith', 'Pvt. Ltd.', 'Dr. Altan', 'St. Louis Trading', 'Altan.Trading']) {
      expect(normalizeEntityName(input), input).toBe(input);
    }
  });

  it('rewrites Russian ООО / OOO (which normalise to the single letter "o") to LLC', () => {
    expect(normalizeEntityName('ООО Ромашка')).toBe('LLC Ромашка');
    expect(normalizeEntityName('Ромашка ooo')).toBe('Ромашка LLC');
    expect(normalizeEntityName('О.О.О. Ромашка')).toBe('LLC Ромашка');
    expect(normalizeEntityName('ОООО Ромашка')).toBe('ОООО Ромашка'); // 4 үсэг ООО биш
    expect(normalizeEntityName('Фоооо')).toBe('Фоооо');
    // "o" нэг үсэг нь хуулийн хэлбэр БИШ хэвээр
    expect(isLegalFormToken('o')).toBe(false);
  });

  // Mutation шалгалт: NFKC-гүй бол бүтэн өргөний цэг (U+FF0E) "." биш тул цувааг таньдаггүй байсан
  it('reads full-width and compatibility characters as their plain forms before looking for dotted runs', () => {
    expect(normalizeEntityName('Zorya Ｌ．Ｌ．Ｃ．')).toBe('Zorya LLC');
    expect(normalizeEntityName('Ｚｏｒｙａ ＯＯＯ')).toBe('Zorya LLC');
    expect(nameSimilarity('Altan Ｌ．Ｌ．Ｃ．', 'Altan', entity)).toBe(1);
  });

  it('is idempotent', () => {
    for (const input of ['Al Noor Trading L.L.C.', 'ООО Ромашка', 'Алтан Х. Х. К.', 'A. Noor', '']) {
      expect(normalizeEntityName(normalizeEntityName(input)), input).toBe(normalizeEntityName(input));
    }
  });
});

describe('entity names with Russian, dotted and South Asian designators', () => {
  it.each([
    ['ООО Ромашка', 'Romashka LLC'],
    ['OOO Romashka', 'Romashka'],
    ['ЗАО Ромашка', 'Romashka CJSC'],
    ['ОАО Ромашка', 'Romashka OJSC'],
    ['Zorya Shipping Pvt. Ltd.', 'Zorya Shipping'],
    ['Zorya Shipping S.A.R.L.', 'Zorya Shipping SRL'],
    ['Al Noor Trading L.L.C.', 'Al Noor Trading LLC'],
  ])('%s ~ %s', (a, b) => {
    expect(nameSimilarity(a, b, entity)).toBe(1);
    expect(nameSimilarity(b, a, entity)).toBe(1);
  });
});
