import { describe, expect, it } from 'vitest';
import { UpdateDisbursementRequest } from '@los/contracts';
import { accountNoProblem, amountProblem, holderNameProblem, parseAmount } from './disbursement.validation';

// F5-5 / F5-16: олголтын маягтын клиент талын шалгалт. Дүрэм бүр серверийн бодит дүрмийг (UpdateDisbursementRequest, BR-10) тусгана.
const APPROVED = 5_000_000;
const AMOUNT_POSITIVE = 'Олгох дүн 0-ээс их байх ёстой';
const AMOUNT_NOT_NUMBER = 'Олгох дүнд зөвхөн тоо бичнэ (жишээ нь 5000000). Үсэг болон бусад тэмдэг оруулж болохгүй.';
const ACCOUNT_DIGITS = 'Дансны дугаарт зөвхөн цифр бичнэ (үсэг, зай, тусгай тэмдэгтгүй)';
const ACCOUNT_LENGTH = 'Дансны дугаар 4–34 цифртэй байх ёстой';
const HOLDER_CHARS = 'Эзэмшигчийн нэрэнд emoji болон < > & тэмдэгт оруулж болохгүй';

describe('accountNoProblem (F5-5): digits only, length mirrors the contract', () => {
  it.each([[undefined], [null], ['']])('treats %j as "not provided" (the saved account is kept)', (v) => {
    expect(accountNoProblem(v)).toBeNull();
  });

  it('accepts plain digit strings', () => {
    expect(accountNoProblem('5012345678')).toBeNull();
    expect(accountNoProblem('1234')).toBeNull();
  });

  it.each([['abcdefg'], ['5012 3456 78'], ['50123456-78'], ['12a45'], ['MN12345678'], ['５０１２３４'], ['٥٠١٢٣٤'], ['1234.56'], [' 5012345678']])('rejects non-digit input %j', (v) => {
    expect(accountNoProblem(v)).toBe(ACCOUNT_DIGITS);
  });

  it.each([['1'], ['123']])('rejects %j as too short', (v) => {
    expect(accountNoProblem(v)).toBe(ACCOUNT_LENGTH);
  });

  it('rejects 35 digits as too long, accepts 34', () => {
    expect(accountNoProblem('1'.repeat(34))).toBeNull();
    expect(accountNoProblem('1'.repeat(35))).toBe(ACCOUNT_LENGTH);
  });

  it('agrees with UpdateDisbursementRequest.accountNo for every boundary length', () => {
    for (const n of [1, 3, 4, 5, 33, 34, 35, 100]) {
      const digits = '1'.repeat(n);
      expect(accountNoProblem(digits) === null, `length ${n}`).toBe(UpdateDisbursementRequest.safeParse({ accountNo: digits }).success);
    }
  });
});

describe('holderNameProblem (F5-5): no emoji, no HTML-like characters', () => {
  it.each([[undefined], [null], ['']])('treats %j as "not provided"', (v) => {
    expect(holderNameProblem(v)).toBeNull();
  });

  it.each([['Номин Дашдорж'], ['Б. Дорж'], ['Өлзийбат Үүрцайх'], ["O'Brien-Smith Jr."], ['Бат-Эрдэнэ 2']])('accepts the ordinary name %j', (v) => {
    expect(holderNameProblem(v)).toBeNull();
  });

  it.each([['😀'], ['Номин 😀'], ['👨‍👩‍👧'], ['🇲🇳 Номин'], ['1️⃣ Номин'], ['❤ Номин']])('rejects emoji in %j', (v) => {
    expect(holderNameProblem(v)).toBe(HOLDER_CHARS);
  });

  it.each([['<script>alert(1)</script>'], ['A & B'], ['a>b'], ['Номин<'], ['&amp;']])('rejects HTML-like characters in %j', (v) => {
    expect(holderNameProblem(v)).toBe(HOLDER_CHARS);
  });
});

describe('parseAmount (F5-16): faithful parse of what the user typed', () => {
  it.each([['5000000', 5_000_000], ['0.01', 0.01], ['5,000,000', 5_000_000], ['1,234.5', 1234.5], ['-5', -5], ['0', 0]])('parses %j', (text, n) => {
    expect(parseAmount(text)).toBe(n);
  });

  it.each([[''], ['  '], ['5сая'], ['5k'], ['abc'], ['1e3'], ['--5'], ['5-'], ['1.2.3'], ['+5'], ['٥'], ['5,5'], ['50,00'], ['5 000'], ['.5'], ['5.']])('returns null for non-numeric %j (never strips characters)', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
});

describe('amountProblem (F5-16): > 0 and <= approved amount (BR-10)', () => {
  it.each([[undefined], [''], ['   '], ['0'], ['0.00'], ['-5'], ['-0.01'], ['0.004']])('rejects %j as not greater than zero (0.004 rounds to 0.00 on the server)', (v) => {
    expect(amountProblem(v, APPROVED)).toBe(AMOUNT_POSITIVE);
  });

  it.each([['5сая'], ['5k'], ['abc'], ['1e3'], ['--5'], ['5,5']])('rejects %j instead of silently stripping to a number', (v) => {
    expect(amountProblem(v, APPROVED)).toBe(AMOUNT_NOT_NUMBER);
  });

  it.each([['5000000'], ['1'], ['0.01'], ['5,000,000'], ['4999999.99'], ['5000000.004']])('accepts %j (within the approved amount, server rounds to 2 decimals)', (v) => {
    expect(amountProblem(v, APPROVED)).toBeNull();
  });

  it.each([['5000000.01'], ['99999999'], ['5,000,001']])('rejects %j above the approved amount and names the limit', (v) => {
    expect(amountProblem(v, APPROVED)).toBe('Олгох дүн батлагдсан дүнгээс (5,000,000₮) хэтэрч болохгүй');
  });
});
