// KHAN parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { statementTextFromDump } from '../engine/text-dump';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.KHAN;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('KHAN specifics', () => {
  it('does not accept images (samples/README.md) and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: false, printsNonStandardIban: false });
  });

  it.each(['Хаан банк', 'Хаанбанк', 'Khan Bank', 'KHAN BANK', 'KhanBank'])('recognises the name variant "%s" in the title', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
  });

  it('a holder name that merely starts with "Хаан" is not a bank name', () => {
    const { text } = bankStatement(spec, specTransactions(spec), {
      header: { titleLines: ['Дансны хуулга'], holder: 'Хаан Констракшн ХХК' },
    });
    expect(spec.parser.detect(text)).toBeLessThan(MIN);
  });

  it('reads the closing balance column ("Эцсийн үлдэгдэл"), not the per-row opening balance ("Эхний үлдэгдэл")', () => {
    const txns = specTransactions(spec);
    const { text, expected } = bankStatement(spec, txns);
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => t.balanceAfter)).toEqual(expected.transactions.map((t) => t.balanceAfter));
    // 1-р мөрийн өмнөх үлдэгдэл = эхний үлдэгдэл, дараа нь тэнцэхгүй
    expect(parsed.transactions[0].balanceAfter).not.toBe(3_000_000);
  });

  it('reads time that is part of the date cell and keeps it', () => {
    const { text } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.every((t) => /^\d{2}:\d{2}:\d{2}$/.test(t.txnTime ?? ''))).toBe(true);
  });

  it('reads a hand-written TAB dump of the assumed layout (no generator)', () => {
    const dump = [
      'SYNTHETIC TEST DATA - NOT A REAL STATEMENT',
      'Хаан банк',
      'Дансны хуулга',
      'Дансны дугаар: 5011223344',
      'Данс эзэмшигч: Бат-Эрдэнэ Болд',
      'Хугацаа: 2026-03-01 - 2026-03-02',
      'Эхний үлдэгдэл: 1,000,000.00',
      ['Огноо', 'Салбар', 'Эхний үлдэгдэл', 'Дебит гүйлгээ', 'Кредит гүйлгээ', 'Эцсийн үлдэгдэл', 'Гүйлгээний утга', 'Харьцсан данс'].join('\t'),
      ['2026-03-01 09:15:00', 'Төв салбар', '1,000,000.00', '0.00', '250,000.00', '1,250,000.00', 'Цалин', '5099887766 Тест Харилцагч'].join('\t'),
      ['2026-03-02 13:40:10', 'Төв салбар', '1,250,000.00', '50,000.00', '0.00', '1,200,000.00', 'QPay төлбөр', ''].join('\t'),
    ].join('\n');
    const parsed = spec.parser.parse(statementTextFromDump(dump, { source: 'PDF_TEXT' }));
    expect(parsed.transactions).toMatchObject([
      { direction: 'INCOME', amount: 250_000, balanceAfter: 1_250_000, txnDate: '2026-03-01', txnTime: '09:15:00', counterpartyAccount: '5099887766' },
      { direction: 'EXPENSE', amount: 50_000, balanceAfter: 1_200_000, txnDate: '2026-03-02', txnTime: '13:40:10', counterpartyAccount: null },
    ]);
    expect(parsed.accountNo).toBe('5011223344');
    expect(parsed.openingBalance).toBe(1_000_000);
  });
});
