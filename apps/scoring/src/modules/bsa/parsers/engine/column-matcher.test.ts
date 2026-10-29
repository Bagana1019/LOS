// column-matcher — баганын нэрийн синоним, хүснэгтийн толгой таних (Монгол/Англи, кирилл/латин холимог). SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { compileColumnMatcher } from './column-matcher';
import { ENGINE_DEFAULTS as cfg } from './defaults';

const m = compileColumnMatcher(cfg);
const line = (cells: string[]) => ({ text: cells.join(' '), cells });
const text = (t: string) => ({ text: t, cells: [t] });

describe('roleOf', () => {
  it.each([
    ['Огноо', 'date'],
    ['Гүйлгээний огноо', 'date'],
    ['Date', 'date'],
    ['Цаг', 'time'],
    ['Гүйлгээний утга', 'description'],
    ['Description', 'description'],
    ['Тайлбар', 'description'],
    ['Дебит', 'debit'],
    ['Дебет', 'debit'],
    ['Зарлага', 'debit'],
    ['Withdrawal', 'debit'],
    ['Кредит', 'credit'],
    ['Орлого', 'credit'],
    ['Deposit', 'credit'],
    ['Дүн', 'amount'],
    ['Amount', 'amount'],
    ['Үлдэгдэл', 'balance'],
    ['Balance', 'balance'],
    ['Харьцсан данс', 'counterparty'],
    ['Харьцсан дансны дугаар', 'counterpartyAccount'],
    ['Харьцсан дансны нэр', 'counterpartyName'],
    ['Төрөл', 'type'],
    ['Дт/Кт', 'type'],
    ['Салбар', 'ignore'],
    ['Валют', 'ignore'],
    ['Эхний үлдэгдэл', 'ignoreAmount'],
    ['№', 'seq'],
  ] as const)('"%s" is %s', (cell, role) => expect(m.roleOf(cell)).toBe(role));

  it('is case, script and spelling-variant tolerant (Latin look-alikes of Cyrillic letters, upper case)', () => {
    expect(m.roleOf('ОГНОО')).toBe('date');
    expect(m.roleOf('Ognoo')).toBe('date'); // латин транслит
    expect(m.roleOf('Үлдэгдэл'.toUpperCase())).toBe('balance');
    expect(m.roleOf('DEBIT')).toBe('debit');
  });

  it('the longest synonym wins ("Харьцсан дансны нэр" is not "Харьцсан данс"; "Эхний үлдэгдэл" is not "Үлдэгдэл")', () => {
    expect(m.roleOf('Харьцсан дансны нэр')).toBe('counterpartyName');
    expect(m.roleOf('Эхний үлдэгдэл')).toBe('ignoreAmount');
    expect(m.roleOf('Эцсийн үлдэгдэл')).toBe('balance');
  });

  it('unknown, empty and very long cells are null', () => {
    expect(m.roleOf('')).toBeNull();
    expect(m.roleOf('Бүртгэлгүй багана')).toBeNull();
    expect(m.roleOf('Огноо '.repeat(40))).toBeNull();
  });

  it('matches whole words: "Dr" does not match inside another word', () => {
    expect(m.roleOf('Address')).toBeNull();
    expect(m.roleOf('Dr')).toBe('debit');
  });

  it('profile synonyms extend the defaults', () => {
    const custom = compileColumnMatcher(cfg, { description: ['Нэмэлт мэдээлэл'], balance: ['Эцсийн үлдэгдэл'] });
    expect(custom.roleOf('Нэмэлт мэдээлэл')).toBe('description');
    expect(custom.roleOf('Огноо')).toBe('date');
  });
});

describe('scan', () => {
  it('lists the synonyms of a single-cell header in the order they appear', () => {
    expect(m.scan('Огноо Цаг Гүйлгээний утга Дебит Кредит Үлдэгдэл')).toEqual(['date', 'time', 'description', 'debit', 'credit', 'balance']);
  });

  it('does not double count a short synonym inside a longer one', () => {
    expect(m.scan('Харьцсан дансны нэр')).toEqual(['counterpartyName']);
  });

  it('returns an empty list for text without synonyms', () => {
    expect(m.scan('2026-03-01 Цалин 1,000.00')).toEqual([]);
  });
});

describe('detectHeader', () => {
  it('recognises a cell-separated header and keeps the cell positions', () => {
    const h = m.detectHeader(line(['Огноо', 'Цаг', 'Гүйлгээний утга', 'Дебит', 'Кредит', 'Үлдэгдэл']));
    expect(h).toMatchObject({
      roles: ['date', 'time', 'description', 'debit', 'credit', 'balance'],
      cellCount: 6,
      cellMapped: true,
      numericRoles: ['debit', 'credit', 'balance'],
      hasDescription: true,
    });
    expect(h?.bodyRoles).toEqual(['description', 'debit', 'credit', 'balance']);
  });

  it('recognises a header that arrived as one text cell, in order but without positions', () => {
    const h = m.detectHeader(text('Огноо Гүйлгээний утга Орлого Зарлага Үлдэгдэл'));
    expect(h).toMatchObject({ cellMapped: false, numericRoles: ['credit', 'debit', 'balance'] });
  });

  it('seq column is kept but does not count as a role; body roles start after date/time/seq', () => {
    const h = m.detectHeader(line(['№', 'Огноо', 'Салбар', 'Утга', 'Дүн', 'Үлдэгдэл']));
    expect(h?.roles).toEqual(['seq', 'date', 'ignore', 'description', 'amount', 'balance']);
    expect(h?.bodyRoles).toEqual(['ignore', 'description', 'amount', 'balance']);
  });

  it('a second date-like column (value date) is ignored, only the first date counts', () => {
    const h = m.detectHeader(line(['Огноо', 'Огноо', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл']));
    expect(h?.roles.slice(0, 2)).toEqual(['date', 'ignore']);
  });

  it('a duplicate balance column (opening per row + closing) keeps the first only', () => {
    const h = m.detectHeader(line(['Огноо', 'Үлдэгдэл', 'Дебит', 'Кредит', 'Үлдэгдэл']));
    expect(h?.roles).toEqual(['date', 'balance', 'debit', 'credit', 'ignore']);
  });

  it('needs a date and at least one money column and enough distinct roles', () => {
    expect(m.detectHeader(line(['Огноо', 'Утга']))).toBeNull();
    expect(m.detectHeader(line(['Огноо', 'Утга', 'Салбар']))).toBeNull(); // мөнгөн багана алга
    expect(m.detectHeader(line(['Утга', 'Дебит', 'Кредит', 'Үлдэгдэл']))).toBeNull(); // огноо алга
  });

  it('a transaction row is not a header', () => {
    expect(m.detectHeader(line(['2026-03-01', '10:00', 'Цалин', '0.00', '1,000.00', '5,000.00']))).toBeNull();
  });

  it('prose that mentions a few column words is not a header', () => {
    expect(m.detectHeader(text('Энэхүү хуулгын огноо болон үлдэгдэл нь банкны системээс гарсан болно'))).toBeNull();
  });

  it('very long lines are rejected without scanning', () => {
    expect(m.detectHeader(text('Огноо Дебит Кредит Үлдэгдэл '.repeat(100)))).toBeNull();
  });

  it('with a known cell-mapped header, a single-cell line is not re-scanned', () => {
    const known = m.detectHeader(line(['Огноо', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл']));
    expect(known).not.toBeNull();
    expect(m.detectHeader(text('Огноо Утга Дебит Кредит Үлдэгдэл'), known)).toBeNull();
    // харин цоо шинэ толгойн мөр нүдтэй ирвэл таниулна
    expect(m.detectHeader(line(['Огноо', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл']), known)).not.toBeNull();
  });
});
