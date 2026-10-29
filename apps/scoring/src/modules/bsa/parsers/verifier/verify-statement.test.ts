// verifyStatement — issue код бүр (BSA-FR-2.2, 2.3). SYNTHETIC өгөгдөл: бүх нэр/данс/дүн зохиомол.
import { describe, expect, it } from 'vitest';
import { BANK_SPECS, bankStatement, specTransactions } from '../banks/testing/bank-specs';
import type { ParsedStatement, VerificationIssueCode, VerificationResult } from '../statement.types';
import { BASELINE_HOLDER, baselineParsed, clone, PDF_META, SYNTHETIC_IBAN, SYNTHETIC_REGISTER_NO } from './testing/baseline';
import { requiresQr, verifyStatement } from './verify-statement';

const codes = (r: VerificationResult): VerificationIssueCode[] => r.issues.map((i) => i.code);
const issue = (r: VerificationResult, code: VerificationIssueCode) => r.issues.find((i) => i.code === code);
const errors = (r: VerificationResult): VerificationIssueCode[] => r.issues.filter((i) => i.severity === 'ERROR').map((i) => i.code);

describe('verifyStatement — baseline', () => {
  it('a consistent statement passes; only the unverified-parser warning remains', () => {
    const parsed = baselineParsed();
    expect(parsed.declaredRowCount).toBe(12);
    expect(parsed.closingBalance).not.toBeNull();
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(r.parserOk).toBe(true);
    expect(r.verifierOk).toBe(true);
    expect(r.qrVerified).toBeNull();
    expect(r.issues).toEqual([{ code: 'UNVERIFIED_PARSER', severity: 'WARNING', message: expect.any(String) }]);
    expect(r.authenticity?.checked).toBe(true);
  });

  it('a verified parser has no UNVERIFIED_PARSER issue', () => {
    const r = verifyStatement({ ...baselineParsed(), parserVerified: true }, {}, PDF_META);
    expect(r.issues).toEqual([]);
  });

  it('does not mutate its input and is deterministic', () => {
    const parsed = baselineParsed();
    const before = JSON.stringify(parsed);
    const a = verifyStatement(parsed, { customer: { names: ['Тест'] } }, PDF_META);
    const b = verifyStatement(parsed, { customer: { names: ['Тест'] } }, PDF_META);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(b).toEqual(a);
  });
});

describe('NO_TRANSACTIONS / ROW_COUNT_MISMATCH', () => {
  it('no transactions is an ERROR and parserOk=false', () => {
    const spec = BANK_SPECS.KHAN;
    const parsed = spec.parser.parse(bankStatement(spec, []).text);
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(errors(r)).toContain('NO_TRANSACTIONS');
    expect(r.parserOk).toBe(false);
    expect(r.verifierOk).toBe(false);
  });

  it('declared row count that differs from the rows read is an ERROR', () => {
    const parsed = { ...baselineParsed(), declaredRowCount: 13 };
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(errors(r)).toContain('ROW_COUNT_MISMATCH');
    expect(issue(r, 'ROW_COUNT_MISMATCH')?.message).toContain('13');
    expect(r.parserOk).toBe(false);
    expect(r.verifierOk).toBe(false);
  });

  it('a matching declared row count passes', () => {
    const r = verifyStatement({ ...baselineParsed(), declaredRowCount: 12 }, {}, PDF_META);
    expect(codes(r)).not.toContain('ROW_COUNT_MISMATCH');
  });

  it('rows that looked like transactions but were not read are an ERROR even without a declared count', () => {
    const parsed = { ...baselineParsed(), declaredRowCount: null, unparsedRowCount: 2 };
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(errors(r)).toContain('ROW_COUNT_MISMATCH');
    expect(issue(r, 'ROW_COUNT_MISMATCH')?.message).toContain('2 row');
    expect(r.parserOk).toBe(false);
  });

  it('counts UNPARSED_ROW warnings when the explicit count is absent', () => {
    const parsed = clone(baselineParsed());
    delete parsed.unparsedRowCount;
    parsed.declaredRowCount = null;
    parsed.warnings.push({ code: 'UNPARSED_ROW', message: 'x', page: 1, line: 9 });
    expect(errors(verifyStatement(parsed, {}, PDF_META))).toContain('ROW_COUNT_MISMATCH');
  });

  it('end to end: a row the engine cannot read makes the verifier fail', () => {
    const spec = BANK_SPECS.GOLOMT;
    const { text } = bankStatement(spec, specTransactions(spec));
    // Огноотой, дүнтэй боловч чиглэл нь тодорхойгүй мөр: тэмдэг, баганын утга, үлдэгдлийн өөрчлөлт байхгүй
    const lines = text.pages[0].lines;
    const at = lines.findIndex((l) => /\d{2}\.\d{2}\.\d{4}/.test(l.text) && !/Огноо/.test(l.text));
    lines.splice(at + 3, 0, { text: '10.03.2026 Тодорхойгүй 12,345.00', cells: ['10.03.2026', 'Тодорхойгүй', '12,345.00'] });
    const parsed = spec.parser.parse(text);
    const r = verifyStatement(parsed, {}, { ...PDF_META });
    expect(parsed.unparsedRowCount ?? 0).toBeGreaterThan(0);
    expect(errors(r)).toContain('ROW_COUNT_MISMATCH');
  });
});

describe('balance chain (BSA-FR-2.2, AC: tampered balance => verifierOk=false)', () => {
  it('a tampered balance in the middle breaks the chain: ERROR with the row number', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[5].balanceAfter = (parsed.transactions[5].balanceAfter as number) + 100_000;
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(r.verifierOk).toBe(false);
    const breaks = r.issues.filter((i) => i.code === 'BALANCE_CHAIN_BREAK');
    expect(breaks.map((b) => b.seq)).toEqual([6, 7]); // 6-р мөр өөрөө, мөн 7-р мөр түүнтэй үл нийцнэ
    expect(breaks.every((b) => b.severity === 'ERROR')).toBe(true);
    expect(breaks[0].message).toContain('of 2');
  });

  it('a tampered amount (balance unchanged) is detected', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[3].amount += 5000;
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(r.verifierOk).toBe(false);
    expect(issue(r, 'BALANCE_CHAIN_BREAK')?.seq).toBe(4);
  });

  it('a flipped direction is detected', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[2].direction = parsed.transactions[2].direction === 'INCOME' ? 'EXPENSE' : 'INCOME';
    expect(errors(verifyStatement(parsed, {}, PDF_META))).toContain('BALANCE_CHAIN_BREAK');
  });

  it('lists at most 10 breaks but reports the total', () => {
    const parsed = clone(baselineParsed(30));
    parsed.transactions.forEach((t, i) => {
      if (i % 2 === 1) t.balanceAfter = (t.balanceAfter as number) + 1000;
    });
    const r = verifyStatement(parsed, {}, PDF_META);
    const breaks = r.issues.filter((i) => i.code === 'BALANCE_CHAIN_BREAK');
    expect(breaks).toHaveLength(10);
    expect(breaks[0].message).toMatch(/of \d+\)$/);
    const total = Number(/of (\d+)\)$/.exec(breaks[0].message)?.[1]);
    expect(total).toBeGreaterThan(10);
    expect(verifyStatement(parsed, { maxListedBreaks: 3 }, PDF_META).issues.filter((i) => i.code === 'BALANCE_CHAIN_BREAK')).toHaveLength(3);
  });

  it('differences within the tolerance pass; beyond it fail; the tolerance is configurable', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[4].balanceAfter = (parsed.transactions[4].balanceAfter as number) + 0.01;
    // 5-р мөрийн үлдэгдлийг 0.01-ээр өөрчилбөл дараагийн мөр дахин 0.01 зөрнө — хоёулаа 0.01 дотор
    expect(codes(verifyStatement(parsed, {}, PDF_META))).not.toContain('BALANCE_CHAIN_BREAK');
    parsed.transactions[4].balanceAfter = (parsed.transactions[4].balanceAfter as number) + 0.5;
    expect(codes(verifyStatement(parsed, {}, PDF_META))).toContain('BALANCE_CHAIN_BREAK');
    expect(codes(verifyStatement(parsed, { balanceTolerance: 1 }, PDF_META))).not.toContain('BALANCE_CHAIN_BREAK');
  });

  it('a break after a row without a balance is still found by carrying the amounts across', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[4].balanceAfter = null;
    parsed.transactions[6].balanceAfter = (parsed.transactions[6].balanceAfter as number) + 777;
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(r.issues.filter((i) => i.code === 'BALANCE_CHAIN_BREAK')[0].seq).toBe(7);
    // үлдэгдэлгүй мөр өөрөө буруу гэж тооцогдохгүй
    expect(r.issues.some((i) => i.code === 'BALANCE_CHAIN_BREAK' && i.seq === 5)).toBe(false);
  });

  it('the opening balance must agree with the first row', () => {
    const parsed = { ...baselineParsed(), openingBalance: 1 };
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(issue(r, 'OPENING_BALANCE_MISMATCH')?.severity).toBe('ERROR');
    expect(issue(r, 'OPENING_BALANCE_MISMATCH')?.seq).toBe(1);
    expect(codes(r)).not.toContain('BALANCE_CHAIN_BREAK');
  });

  it('the closing balance must agree with the last row', () => {
    const parsed = { ...baselineParsed(), closingBalance: 1 };
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(issue(r, 'CLOSING_BALANCE_MISMATCH')?.severity).toBe('ERROR');
    expect(issue(r, 'CLOSING_BALANCE_MISMATCH')?.seq).toBe(12);
    expect(r.verifierOk).toBe(false);
  });

  it('opening and closing are checked even when the first/last rows have no balance', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[0].balanceAfter = null;
    parsed.transactions[11].balanceAfter = null;
    expect(codes(verifyStatement(parsed, {}, PDF_META))).not.toContain('CLOSING_BALANCE_MISMATCH');
    parsed.closingBalance = (parsed.closingBalance as number) + 50;
    expect(codes(verifyStatement(parsed, {}, PDF_META))).toContain('CLOSING_BALANCE_MISMATCH');
  });

  it('statements without a balance column: warning, and opening + sum of rows is compared with the closing balance', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions.forEach((t) => (t.balanceAfter = null));
    const ok = verifyStatement(parsed, {}, PDF_META);
    expect(issue(ok, 'BALANCE_UNAVAILABLE')?.severity).toBe('WARNING');
    expect(ok.verifierOk).toBe(true);
    expect(codes(ok)).not.toContain('CLOSING_BALANCE_MISMATCH');
    parsed.closingBalance = (parsed.closingBalance as number) + 1000;
    const bad = verifyStatement(parsed, {}, PDF_META);
    expect(errors(bad)).toContain('CLOSING_BALANCE_MISMATCH');
  });

  it('balance unavailable for most rows (below the coverage threshold) is a warning, a few missing rows are not', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions.forEach((t, i) => {
      if (i % 4 !== 0) t.balanceAfter = null; // 3 of 12 have balances
    });
    expect(codes(verifyStatement(parsed, {}, PDF_META))).toContain('BALANCE_UNAVAILABLE');
    const few = clone(baselineParsed());
    few.transactions[3].balanceAfter = null;
    expect(codes(verifyStatement(few, {}, PDF_META))).not.toContain('BALANCE_UNAVAILABLE');
  });

  it('reversed debit/credit file: the engine corrects it and the verifier passes; a parse that kept the wrong directions fails the chain', () => {
    const spec = BANK_SPECS.GOLOMT;
    const { text } = bankStatement(spec, specTransactions(spec), { debitIsIncome: true, header: { showClosing: true, footerSummary: true } });
    const parsed = spec.parser.parse(text);
    expect(parsed.warnings.map((w) => w.code)).toContain('DIRECTION_SWAPPED');
    expect(verifyStatement(parsed, {}, PDF_META).verifierOk).toBe(true);

    const wrong = clone(parsed);
    wrong.transactions.forEach((t) => (t.direction = t.direction === 'INCOME' ? 'EXPENSE' : 'INCOME'));
    const r = verifyStatement(wrong, {}, PDF_META);
    expect(r.verifierOk).toBe(false);
    expect(errors(r)).toContain('BALANCE_CHAIN_BREAK');
  });

  it('newest-first file read in chronological order passes', () => {
    const spec = BANK_SPECS.TDB;
    const { text } = bankStatement(spec, specTransactions(spec), { newestFirst: true, header: { showClosing: true, footerSummary: true } });
    expect(verifyStatement(spec.parser.parse(text), {}, PDF_META).verifierOk).toBe(true);
  });
});

describe('IBAN_INVALID', () => {
  it('a valid IBAN passes; absent IBAN is not checked', () => {
    const parsed = baselineParsed();
    expect(parsed.iban).toBe(SYNTHETIC_IBAN);
    expect(codes(verifyStatement(parsed, {}, PDF_META))).not.toContain('IBAN_INVALID');
    expect(codes(verifyStatement({ ...parsed, iban: null }, {}, PDF_META))).not.toContain('IBAN_INVALID');
  });

  it('a wrong checksum is an ERROR and the message does not contain the IBAN', () => {
    const bad = SYNTHETIC_IBAN.replace('MN64', 'MN65');
    const r = verifyStatement({ ...baselineParsed(), iban: bad }, {}, PDF_META);
    expect(issue(r, 'IBAN_INVALID')?.severity).toBe('ERROR');
    expect(r.verifierOk).toBe(false);
    expect(issue(r, 'IBAN_INVALID')?.message).not.toContain(bad);
  });

  it('wrong length / structure is invalid', () => {
    for (const bad of ['MN640005123456789', 'XX640005123456789012', 'garbage']) {
      expect(codes(verifyStatement({ ...baselineParsed(), iban: bad }, {}, PDF_META)), bad).toContain('IBAN_INVALID');
    }
  });

  it('a bank that prints non-standard IBANs only gets a WARNING (policy), unless severity is set explicitly', () => {
    const bad = SYNTHETIC_IBAN.replace('MN64', 'MN65');
    const policy = { acceptsImages: true, printsNonStandardIban: true };
    const soft = verifyStatement({ ...baselineParsed(), iban: bad }, { policy }, PDF_META);
    expect(issue(soft, 'IBAN_INVALID')?.severity).toBe('WARNING');
    expect(soft.verifierOk).toBe(true);
    const hard = verifyStatement({ ...baselineParsed(), iban: bad }, { policy, severity: { IBAN_INVALID: 'ERROR' } }, PDF_META);
    expect(issue(hard, 'IBAN_INVALID')?.severity).toBe('ERROR');
  });
});

describe('NAME_MISMATCH / REGISTER_MISMATCH (BSA-BR: нэр регистртэй тулгах)', () => {
  const customer = { names: [BASELINE_HOLDER], registerNo: SYNTHETIC_REGISTER_NO };

  it('the same name passes; the Latin spelling of the same name passes', () => {
    const parsed = baselineParsed();
    expect(parsed.holderName).toBe(BASELINE_HOLDER);
    expect(codes(verifyStatement(parsed, { customer }, PDF_META))).not.toContain('NAME_MISMATCH');
    for (const latin of ['Bat-Erdene Bold', 'BOLD BAT-ERDENE', 'Bold Baterdene']) {
      const r = verifyStatement(parsed, { customer: { names: [latin] } }, PDF_META);
      expect(codes(r), latin).not.toContain('NAME_MISMATCH');
    }
  });

  it('a different person is an ERROR; the message does not contain the names', () => {
    const r = verifyStatement(baselineParsed(), { customer: { names: ['Дорж Сүхбаатар'] } }, PDF_META);
    expect(issue(r, 'NAME_MISMATCH')?.severity).toBe('ERROR');
    expect(r.verifierOk).toBe(false);
    expect(issue(r, 'NAME_MISMATCH')?.message).not.toMatch(/Болд|Дорж/);
  });

  it('any of several customer names may match', () => {
    const r = verifyStatement(baselineParsed(), { customer: { names: ['Дорж Сүхбаатар', 'Bold Baterdene'] } }, PDF_META);
    expect(codes(r)).not.toContain('NAME_MISMATCH');
  });

  it('is skipped when the statement prints no name, or the customer has no names, or no customer is given', () => {
    const parsed = baselineParsed();
    expect(codes(verifyStatement({ ...parsed, holderName: null }, { customer: { names: ['Дорж Сүхбаатар'] } }, PDF_META))).not.toContain('NAME_MISMATCH');
    expect(codes(verifyStatement(parsed, { customer: { names: [] } }, PDF_META))).not.toContain('NAME_MISMATCH');
    expect(codes(verifyStatement(parsed, { customer: { names: ['  '] } }, PDF_META))).not.toContain('NAME_MISMATCH');
    expect(codes(verifyStatement(parsed, {}, PDF_META))).not.toContain('NAME_MISMATCH');
  });

  it('the name matching threshold is configurable', () => {
    const parsed = { ...baselineParsed(), holderName: 'Бат-Эрдэнэ Болдоо' };
    const strict = verifyStatement(parsed, { customer: { names: [BASELINE_HOLDER] }, nameMinScore: 0.99 }, PDF_META);
    expect(codes(strict)).toContain('NAME_MISMATCH');
  });

  it('the register number: same number in another format passes; a different number is an ERROR', () => {
    const parsed = baselineParsed();
    expect(parsed.holderRegisterNo).toBe(SYNTHETIC_REGISTER_NO);
    expect(codes(verifyStatement(parsed, { customer: { names: [], registerNo: 'жю-85061512' } }, PDF_META))).not.toContain('REGISTER_MISMATCH');
    const bad = verifyStatement(parsed, { customer: { names: [], registerNo: 'УБ90010203' } }, PDF_META);
    expect(issue(bad, 'REGISTER_MISMATCH')?.severity).toBe('ERROR');
    expect(bad.verifierOk).toBe(false);
    expect(issue(bad, 'REGISTER_MISMATCH')?.message).not.toContain('УБ90010203');
  });

  it('the register check is skipped when it is not printed, or the customer register is missing/invalid', () => {
    const parsed = baselineParsed();
    expect(codes(verifyStatement({ ...parsed, holderRegisterNo: null }, { customer: { names: [], registerNo: 'УБ90010203' } }, PDF_META))).not.toContain('REGISTER_MISMATCH');
    expect(codes(verifyStatement(parsed, { customer: { names: [], registerNo: null } }, PDF_META))).not.toContain('REGISTER_MISMATCH');
    expect(codes(verifyStatement(parsed, { customer: { names: [], registerNo: 'not-a-register' } }, PDF_META))).not.toContain('REGISTER_MISMATCH');
  });

  it('severity is configurable per code: WARNING keeps verifierOk true, OFF removes the issue', () => {
    const opts = { customer: { names: ['Дорж Сүхбаатар'], registerNo: 'УБ90010203' } };
    const soft = verifyStatement(baselineParsed(), { ...opts, severity: { NAME_MISMATCH: 'WARNING', REGISTER_MISMATCH: 'WARNING' } }, PDF_META);
    expect(issue(soft, 'NAME_MISMATCH')?.severity).toBe('WARNING');
    expect(issue(soft, 'REGISTER_MISMATCH')?.severity).toBe('WARNING');
    expect(soft.verifierOk).toBe(true);
    const off = verifyStatement(baselineParsed(), { ...opts, severity: { NAME_MISMATCH: 'OFF', REGISTER_MISMATCH: 'OFF' } }, PDF_META);
    expect(codes(off)).not.toContain('NAME_MISMATCH');
    expect(codes(off)).not.toContain('REGISTER_MISMATCH');
  });
});

describe('DATE_ORDER / PERIOD_MISMATCH / DUPLICATE_ROWS', () => {
  it('a row dated earlier than the previous one is a WARNING (the chain may still be fine)', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[6].txnDate = '2026-01-01';
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(issue(r, 'DATE_ORDER')?.severity).toBe('WARNING');
    expect(issue(r, 'DATE_ORDER')?.seq).toBe(7);
    expect(r.verifierOk).toBe(true);
  });

  it('same-day rows with earlier time are out of order too', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[1].txnDate = parsed.transactions[0].txnDate;
    parsed.transactions[0].txnTime = '23:00:00';
    parsed.transactions[1].txnTime = '01:00:00';
    expect(codes(verifyStatement(parsed, {}, PDF_META))).toContain('DATE_ORDER');
  });

  it('rows outside the declared period are a WARNING; an inverted period too', () => {
    const parsed = clone(baselineParsed());
    parsed.periodTo = '2026-02-27';
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(issue(r, 'PERIOD_MISMATCH')?.severity).toBe('WARNING');
    expect(issue(r, 'PERIOD_MISMATCH')?.message).toMatch(/row\(s\) fall outside/);
    const inverted = verifyStatement({ ...parsed, periodFrom: '2026-04-01', periodTo: '2026-03-01' }, {}, PDF_META);
    expect(issue(inverted, 'PERIOD_MISMATCH')?.message).toMatch(/start is after/);
  });

  it('a period that covers every row has no PERIOD_MISMATCH; a missing period is not checked', () => {
    const parsed = baselineParsed();
    expect(codes(verifyStatement(parsed, {}, PDF_META))).not.toContain('PERIOD_MISMATCH');
    expect(codes(verifyStatement({ ...parsed, periodFrom: null, periodTo: null }, {}, PDF_META))).not.toContain('PERIOD_MISMATCH');
  });

  it('an exact repeat of a row is a WARNING; a row differing in balance is not a duplicate', () => {
    const parsed = clone(baselineParsed());
    const dup = { ...parsed.transactions[3], seq: 99 };
    parsed.transactions.splice(4, 0, dup);
    const r = verifyStatement(parsed, {}, PDF_META);
    expect(issue(r, 'DUPLICATE_ROWS')?.severity).toBe('WARNING');
    expect(issue(r, 'DUPLICATE_ROWS')?.seq).toBe(99);
    const other = clone(baselineParsed());
    other.transactions.splice(4, 0, { ...other.transactions[3], seq: 99, balanceAfter: 1 });
    expect(codes(verifyStatement(other, {}, PDF_META))).not.toContain('DUPLICATE_ROWS');
  });

  it('Latin/Cyrillic/case differences in the description still count as the same row', () => {
    const parsed = clone(baselineParsed());
    const dup = { ...parsed.transactions[3], seq: 98, description: parsed.transactions[3].description.toUpperCase() };
    parsed.transactions.splice(4, 0, dup);
    expect(codes(verifyStatement(parsed, {}, PDF_META))).toContain('DUPLICATE_ROWS');
  });
});

describe('UNVERIFIED_PARSER', () => {
  it('is a WARNING for an unverified parser and can be turned off', () => {
    const r = verifyStatement(baselineParsed(), {}, PDF_META);
    expect(issue(r, 'UNVERIFIED_PARSER')?.severity).toBe('WARNING');
    expect(codes(verifyStatement(baselineParsed(), { severity: { UNVERIFIED_PARSER: 'OFF' } }, PDF_META))).not.toContain('UNVERIFIED_PARSER');
  });
});

describe('images, OCR and QR (BSA-FR-2.1, 2.3)', () => {
  const image = { ...PDF_META, mimeType: 'image/jpeg', pdf: undefined };

  it('an image is an ERROR for a bank that does not accept images, fine for the others', () => {
    const no = verifyStatement(baselineParsed(), { policy: { acceptsImages: false, printsNonStandardIban: false } }, image);
    expect(issue(no, 'IMAGE_NOT_ACCEPTED')?.severity).toBe('ERROR');
    expect(no.verifierOk).toBe(false);
    const yes = verifyStatement(baselineParsed(), { policy: { acceptsImages: true, printsNonStandardIban: false } }, image);
    expect(codes(yes)).not.toContain('IMAGE_NOT_ACCEPTED');
    // PDF-д хамаарахгүй
    const pdf = verifyStatement(baselineParsed(), { policy: { acceptsImages: false, printsNonStandardIban: false } }, PDF_META);
    expect(codes(pdf)).not.toContain('IMAGE_NOT_ACCEPTED');
  });

  it('PNG and uppercase mime types count as images', () => {
    for (const mimeType of ['image/png', 'IMAGE/JPEG']) {
      const r = verifyStatement(baselineParsed(), { policy: { acceptsImages: false, printsNonStandardIban: false } }, { ...image, mimeType });
      expect(codes(r), mimeType).toContain('IMAGE_NOT_ACCEPTED');
    }
  });

  it('OCR mean confidence below the threshold is a WARNING; at/above it is not; the threshold is configurable', () => {
    const low = { ...image, ocr: { engine: 'tesseract', meanConfidence: 0.55 } };
    expect(issue(verifyStatement(baselineParsed(), {}, low), 'OCR_LOW_CONFIDENCE')?.severity).toBe('WARNING');
    const high = { ...image, ocr: { engine: 'tesseract', meanConfidence: 0.95 } };
    expect(codes(verifyStatement(baselineParsed(), {}, high))).not.toContain('OCR_LOW_CONFIDENCE');
    expect(codes(verifyStatement(baselineParsed(), { ocrMinConfidence: 0.5 }, low))).not.toContain('OCR_LOW_CONFIDENCE');
    expect(codes(verifyStatement(baselineParsed(), { ocrMinConfidence: 0.99 }, high))).toContain('OCR_LOW_CONFIDENCE');
  });

  it('requiresQr: images and files that carry QR payloads', () => {
    expect(requiresQr(image)).toBe(true);
    expect(requiresQr({ ...PDF_META, qrPayloads: ['x'] })).toBe(true);
    expect(requiresQr({ ...PDF_META, qrPayloads: [] })).toBe(false);
    expect(requiresQr(PDF_META)).toBe(false);
  });

  it('an image whose QR could not be verified (null) gets QR_NOT_VERIFIED as a WARNING and qrVerified=null', () => {
    const r = verifyStatement(baselineParsed(), {}, image);
    expect(issue(r, 'QR_NOT_VERIFIED')?.severity).toBe('WARNING');
    expect(r.qrVerified).toBeNull();
    expect(r.verifierOk).toBe(true);
  });

  it('a verified QR removes the warning', () => {
    const r = verifyStatement(baselineParsed(), {}, image, true);
    expect(codes(r)).not.toContain('QR_NOT_VERIFIED');
    expect(r.qrVerified).toBe(true);
  });

  it('a QR the bank rejected is an ERROR (unless the severity is set explicitly)', () => {
    const r = verifyStatement(baselineParsed(), {}, image, false);
    expect(issue(r, 'QR_NOT_VERIFIED')?.severity).toBe('ERROR');
    expect(r.qrVerified).toBe(false);
    expect(r.verifierOk).toBe(false);
    const soft = verifyStatement(baselineParsed(), { severity: { QR_NOT_VERIFIED: 'WARNING' } }, image, false);
    expect(issue(soft, 'QR_NOT_VERIFIED')?.severity).toBe('WARNING');
    const off = verifyStatement(baselineParsed(), { severity: { QR_NOT_VERIFIED: 'OFF' } }, image, false);
    expect(codes(off)).not.toContain('QR_NOT_VERIFIED');
  });

  it('a plain PDF without a QR gets no QR issue', () => {
    const r = verifyStatement(baselineParsed(), {}, PDF_META);
    expect(codes(r)).not.toContain('QR_NOT_VERIFIED');
    expect(r.qrVerified).toBeNull();
  });

  it('a PDF that carries a QR is treated like an image statement for QR_NOT_VERIFIED', () => {
    const r = verifyStatement(baselineParsed(), {}, { ...PDF_META, qrPayloads: ['SYNTHETIC-QR'] });
    expect(codes(r)).toContain('QR_NOT_VERIFIED');
  });
});

describe('PDF metadata (BSA-FR-2.3) through verifyStatement', () => {
  it('a suspicious producer and a late modification are WARNINGs and are reported in authenticity', () => {
    const meta = {
      ...PDF_META,
      pdf: { ...PDF_META.pdf!, producer: 'Adobe Photoshop 25', modDate: '2026-04-15T12:00:00Z' },
    };
    const r = verifyStatement(baselineParsed(), {}, meta);
    expect(issue(r, 'PDF_METADATA_SUSPICIOUS')?.severity).toBe('WARNING');
    expect(issue(r, 'PDF_MODIFIED')?.severity).toBe('WARNING');
    expect(r.verifierOk).toBe(true);
    expect(r.authenticity?.suspiciousSignatures).toContain('Photoshop');
    expect(r.authenticity?.modifiedAfterSeconds).toBeGreaterThan(60);
  });

  it('severity can be raised to ERROR', () => {
    const meta = { ...PDF_META, pdf: { ...PDF_META.pdf!, producer: 'Smallpdf.com' } };
    const r = verifyStatement(baselineParsed(), { severity: { PDF_METADATA_SUSPICIOUS: 'ERROR' } }, meta);
    expect(r.verifierOk).toBe(false);
  });

  it('a non-PDF file reports checked=false', () => {
    const r = verifyStatement(baselineParsed(), {}, { ...PDF_META, mimeType: 'text/csv', pdf: undefined });
    expect(r.authenticity?.checked).toBe(false);
  });
});

describe('several problems at once, and PII', () => {
  it('reports every problem and keeps names, accounts, IBAN and descriptions out of all messages', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[5].balanceAfter = 1;
    parsed.declaredRowCount = 99;
    parsed.iban = SYNTHETIC_IBAN.replace('MN64', 'MN65');
    parsed.holderRegisterNo = 'УБ90010203';
    const r = verifyStatement(parsed, { customer: { names: ['Дорж Сүхбаатар'], registerNo: SYNTHETIC_REGISTER_NO } }, {
      ...PDF_META,
      pdf: { ...PDF_META.pdf!, producer: 'Microsoft® Word 2019' },
    });
    expect(errors(r)).toEqual(expect.arrayContaining(['ROW_COUNT_MISMATCH', 'BALANCE_CHAIN_BREAK', 'IBAN_INVALID', 'NAME_MISMATCH', 'REGISTER_MISMATCH']));
    expect(r.verifierOk).toBe(false);
    const all = r.issues.map((i) => i.message).join('\n');
    for (const secret of [BASELINE_HOLDER, 'Дорж', 'Сүхбаатар', parsed.accountNo as string, parsed.iban, 'УБ90010203', SYNTHETIC_REGISTER_NO, parsed.transactions[0].description]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('result shape', () => {
  it('every issue has a code, a severity and a message', () => {
    const parsed = clone(baselineParsed());
    parsed.transactions[2].balanceAfter = 5;
    const r: VerificationResult = verifyStatement(parsed as ParsedStatement, {}, PDF_META);
    for (const i of r.issues) {
      expect(i.code).toMatch(/^[A-Z_]+$/);
      expect(['ERROR', 'WARNING']).toContain(i.severity);
      expect(i.message.length).toBeGreaterThan(0);
    }
  });
});
