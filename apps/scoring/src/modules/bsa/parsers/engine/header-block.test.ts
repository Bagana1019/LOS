// header-block — толгой хэсгийн талбарууд (Монгол + Англи шошго; утга ижил нүдэнд / дараагийн нүдэнд / дараагийн мөрөнд). SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { ENGINE_DEFAULTS as cfg } from './defaults';
import { compileHeaderExtractor, type ZoneLine } from './header-block';
import { WarningCollector } from './warnings';

const extractor = compileHeaderExtractor(cfg, { dateOrder: 'DMY' });
const zone = (...lines: string[][]): ZoneLine[] => lines.map((cells, i) => ({ cells, page: 1, line: i + 1 }));
const run = (lines: ZoneLine[], ex = extractor) => {
  const warnings = new WarningCollector(100);
  const fields = ex.extractZone(lines, warnings);
  return { fields, warnings: warnings.finish() };
};

describe('extractZone — placement of the value', () => {
  it('"Label: value" in one cell', () => {
    const { fields } = run(zone(['Дансны дугаар: 5011223344'], ['Данс эзэмшигч: Бат-Эрдэнэ Болд'], ['Валют: MNT']));
    expect(fields).toMatchObject({ accountNo: '5011223344', holderName: 'Бат-Эрдэнэ Болд', currency: 'MNT' });
  });

  it('value in the next cell of the same line', () => {
    const { fields } = run(zone(['Дансны дугаар:', '5011223344'], ['Данс эзэмшигч', 'Бат-Эрдэнэ Болд']));
    expect(fields).toMatchObject({ accountNo: '5011223344', holderName: 'Бат-Эрдэнэ Болд' });
  });

  it('value on the next line', () => {
    const { fields } = run(zone(['Дансны дугаар'], ['5011223344'], ['Эхний үлдэгдэл'], ['1,000,000.00']));
    expect(fields).toMatchObject({ accountNo: '5011223344', openingBalance: 1_000_000 });
  });

  it('a row of labels followed by a row of values', () => {
    const { fields } = run(zone(['Дансны дугаар', 'Валют', 'Эхний үлдэгдэл'], ['5011223344', 'MNT', '250,000.00']));
    expect(fields).toMatchObject({ accountNo: '5011223344', currency: 'MNT', openingBalance: 250_000 });
  });

  it('several label/value pairs in one line', () => {
    const { fields } = run(zone(['Дансны дугаар: 5011223344   Валют: MNT   Эхний үлдэгдэл: 1,500.50']));
    expect(fields).toMatchObject({ accountNo: '5011223344', currency: 'MNT', openingBalance: 1500.5 });
  });

  it('English labels', () => {
    const { fields } = run(
      zone(['Account number: 5011223344'], ['Account holder: Bold Baterdene'], ['Opening balance: 10,000.00'], ['Closing balance: 12,500.00'], ['Total transactions: 42']),
    );
    expect(fields).toMatchObject({ accountNo: '5011223344', holderName: 'Bold Baterdene', openingBalance: 10_000, closingBalance: 12_500, declaredRowCount: 42 });
  });
});

describe('extractZone — individual fields', () => {
  it('IBAN: own label, or inside the account label, or anywhere in the zone', () => {
    expect(run(zone(['IBAN: MN64 0005 1234 5678 9012'])).fields.iban).toBe('MN640005123456789012');
    expect(run(zone(['Дансны дугаар: MN640005123456789012'])).fields).toMatchObject({ iban: 'MN640005123456789012', accountNo: null });
    expect(run(zone(['Хаяг: ...'], ['Ref MN640005123456789012 printed'])).fields.iban).toBe('MN640005123456789012');
  });

  it('IBAN and the domestic account may be printed together', () => {
    const { fields } = run(zone(['Дансны дугаар: 5011223344 / MN640005123456789012']));
    expect(fields).toMatchObject({ accountNo: '5011223344', iban: 'MN640005123456789012' });
  });

  it('holder name with the register number in brackets', () => {
    const { fields } = run(zone(['Харилцагчийн нэр: Бат-Эрдэнэ Болд (ЖЮ85061512)']));
    expect(fields).toMatchObject({ holderName: 'Бат-Эрдэнэ Болд', registerNo: 'ЖЮ85061512' });
  });

  it('register number with its own label, Latin look-alike letters normalised', () => {
    expect(run(zone(['Регистрийн дугаар: ЖЮ85061512'])).fields.registerNo).toBe('ЖЮ85061512');
    expect(run(zone(['Register number: xy-85061512'])).fields.registerNo).toBe('ХУ85061512'); // латин x, y → кирилл Х, У
    expect(run(zone(['Register number: UB-90010203'])).fields.registerNo).toBeNull(); // латин транслитыг таамаглахгүй
  });

  it('period as a range, and as separate start / end', () => {
    expect(run(zone(['Хугацаа: 2026-01-01 - 2026-03-31'])).fields).toMatchObject({ periodFrom: '2026-01-01', periodTo: '2026-03-31' });
    expect(run(zone(['Хугацаа: 31.03.2026 - 01.01.2026'])).fields).toMatchObject({ periodFrom: '2026-01-01', periodTo: '2026-03-31' });
    expect(run(zone(['Эхлэх огноо: 2026-01-01'], ['Дуусах огноо: 2026-03-31'])).fields).toMatchObject({ periodFrom: '2026-01-01', periodTo: '2026-03-31' });
    expect(run(zone(['Statement period: 01/02/2026 - 28/02/2026'])).fields).toMatchObject({ periodFrom: '2026-02-01', periodTo: '2026-02-28' });
  });

  it('currency code, or a tugrik sign', () => {
    expect(run(zone(['Валют: USD'])).fields.currency).toBe('USD');
    expect(run(zone(['Валют: ₮'])).fields.currency).toBe('MNT');
  });

  it('balances: grouped, signed, with trailing currency', () => {
    expect(run(zone(['Эхний үлдэгдэл: 1,234,567.89 MNT'])).fields.openingBalance).toBe(1234567.89);
    expect(run(zone(['Эцсийн үлдэгдэл: -500.00'])).fields.closingBalance).toBe(-500);
  });

  it('declared row count must be a whole number (an amount after "Нийт гүйлгээ" is not a count)', () => {
    expect(run(zone(['Нийт гүйлгээний тоо: 128'])).fields.declaredRowCount).toBe(128);
    expect(run(zone(['Нийт гүйлгээ: 1,200,000.00'])).fields.declaredRowCount).toBeNull();
  });
});

describe('extractZone — robustness', () => {
  it('conflicting values: the first is kept and HEADER_FIELD_CONFLICT is reported', () => {
    const { fields, warnings } = run(zone(['Дансны дугаар: 5011223344'], ['Дансны дугаар: 5099887766']));
    expect(fields.accountNo).toBe('5011223344');
    expect(warnings.map((w) => w.code)).toContain('HEADER_FIELD_CONFLICT');
  });

  it('unreadable values are reported as HEADER_FIELD_INVALID and leave the field empty', () => {
    const { fields, warnings } = run(zone(['Эхний үлдэгдэл: n/a'], ['Эхлэх огноо: хүлээгдэж байна']));
    expect(fields.openingBalance).toBeNull();
    expect(fields.periodFrom).toBeNull();
    expect(warnings.filter((w) => w.code === 'HEADER_FIELD_INVALID')).toHaveLength(2);
  });

  it('no PII in warning messages', () => {
    const { warnings } = run(zone(['Дансны дугаар: 5011223344'], ['Дансны дугаар: 5099887766'], ['Эхний үлдэгдэл: n/a']));
    for (const w of warnings) expect(w.message).not.toMatch(/5011223344|5099887766|n\/a/);
  });

  it('a short label such as "Нэр" or "To" is a label only after ":" or at a cell boundary, not inside a sentence', () => {
    const inSentence = run(zone(['Энэ нэр дээр гүйлгээ хийсэн to Bat болон нэр Дорж']));
    expect(inSentence.fields.holderName).toBeNull();
    expect(inSentence.fields.periodTo).toBeNull();
    expect(run(zone(['Нэр: Дорж Бат'])).fields.holderName).toBe('Дорж Бат');
  });

  it('empty zone and garbage lines give empty fields', () => {
    expect(run([]).fields).toMatchObject({ accountNo: null, iban: null, holderName: null, openingBalance: null });
    expect(run(zone(['@@@@ ####'], ['  '])).fields.accountNo).toBeNull();
  });

  it('very long lines do not hang', () => {
    const t = Date.now();
    run(zone(['Дансны дугаар '.repeat(3000)], [': '.repeat(5000)], ['Нэр'.repeat(5000)]));
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('profile labels extend the defaults', () => {
    const custom = compileHeaderExtractor(cfg, { dateOrder: 'DMY', headerLabels: { holderName: ['Хэрэглэгч'] } });
    expect(run(zone(['Хэрэглэгч: Дорж Бат']), custom).fields.holderName).toBe('Дорж Бат');
    expect(run(zone(['Хэрэглэгч: Дорж Бат'])).fields.holderName).toBeNull();
  });

  it('the period order follows the profile (MDY vs DMY) for ambiguous numeric dates', () => {
    const mdy = compileHeaderExtractor(cfg, { dateOrder: 'MDY' });
    expect(run(zone(['Хугацаа: 03/04/2026 - 05/06/2026']), mdy).fields).toMatchObject({ periodFrom: '2026-03-04', periodTo: '2026-05-06' });
    expect(run(zone(['Хугацаа: 03/04/2026 - 05/06/2026'])).fields).toMatchObject({ periodFrom: '2026-04-03', periodTo: '2026-06-05' });
  });
});

describe('extractFooterLine', () => {
  const footer = (cells: string[], next?: string[]) => {
    const warnings = new WarningCollector(100);
    return extractor.extractFooterLine({ cells, page: 1, line: 1 }, warnings, next ? () => next : undefined);
  };

  it('reads closing balance and row count lines; other header fields are ignored', () => {
    expect(footer(['Эцсийн үлдэгдэл: 9,000.00'])).toMatchObject({ matched: true, fields: { closingBalance: 9000 } });
    expect(footer(['Нийт гүйлгээний тоо: 12'])).toMatchObject({ matched: true, fields: { declaredRowCount: 12 } });
    expect(footer(['Данс эзэмшигч: Дорж Бат']).matched).toBe(false);
  });

  it('value in the next cell or on the next line', () => {
    expect(footer(['Эцсийн үлдэгдэл:', '9,000.00']).fields.closingBalance).toBe(9000);
    expect(footer(['Эцсийн үлдэгдэл'], ['9,000.00']).fields.closingBalance).toBe(9000);
  });

  it('a transaction-like description line is not a footer', () => {
    expect(footer(['QPay төлбөр дэлгүүр 12,000.00']).matched).toBe(false);
  });

  it('a footer label without a readable value is still "matched" (not a description continuation)', () => {
    expect(footer(['Эцсийн үлдэгдэл: n/a'])).toMatchObject({ matched: true, fields: { closingBalance: null } });
  });
});
