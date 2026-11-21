import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import { describeDisbursementError } from './disbursement.errors';

// F5-4: серверийн zod алдаа (англи текст, camelCase нэр) → монгол мессеж + талбарын label. Бодит body: `{ code:'VALIDATION_FAILED', details:[{ path:'accountNo', message }] }`.
const validation = (...issues: Array<[string, string]>) =>
  new ApiError(400, 'VALIDATION_FAILED', 'Оруулсан өгөгдөл буруу', issues.map(([path, message]) => ({ path, message })));
const LATIN = /[A-Za-z]/;

describe('describeDisbursementError: field issues (F5-4)', () => {
  it('maps "at least 4 character(s)" on accountNo to a Mongolian message with the field label', () => {
    const d = describeDisbursementError(validation(['accountNo', 'String must contain at least 4 character(s)']));
    expect(d.fields).toEqual([{ name: 'accountNo', message: 'Дансны дугаар хамгийн багадаа 4 тэмдэгт байх ёстой' }]);
  });

  it('maps "at most 34 character(s)" to a max-length message', () => {
    const d = describeDisbursementError(validation(['accountNo', 'String must contain at most 34 character(s)']));
    expect(d.fields).toEqual([{ name: 'accountNo', message: 'Дансны дугаар хамгийн ихдээ 34 тэмдэгт байх ёстой' }]);
  });

  it('treats "at least 1 character(s)" as a required field', () => {
    const d = describeDisbursementError(validation(['holderName', 'String must contain at least 1 character(s)']));
    expect(d.fields).toEqual([{ name: 'holderName', message: 'Эзэмшигчийн нэр заавал бөглөнө' }]);
  });

  it('maps "Required" to a required message with the label', () => {
    const d = describeDisbursementError(validation(['bankCode', 'Required']));
    expect(d.fields).toEqual([{ name: 'bankCode', message: 'Банкны код заавал бөглөнө' }]);
  });

  it('maps a non-positive amount to the existing amount message', () => {
    const d = describeDisbursementError(validation(['disburseAmount', 'Number must be greater than 0']));
    expect(d.fields).toEqual([{ name: 'disburseAmount', message: 'Олгох дүн 0-ээс их байх ёстой' }]);
  });

  it('maps an invalid date (regex) and an invalid enum to "<label> буруу байна"', () => {
    const d = describeDisbursementError(validation(['disburseDate', 'Invalid'], ['accountOwnerType', "Invalid enum value. Expected 'SELF' | 'THIRD_PARTY', received 'X'"]));
    expect(d.fields).toEqual([
      { name: 'disburseDate', message: 'Олгох огноо буруу байна' },
      { name: 'accountOwnerType', message: 'Дансны эзэмшигч буруу байна' },
    ]);
  });

  it('keeps one error per field, in order, and ignores the dotted tail of a path', () => {
    const d = describeDisbursementError(validation(['accountNo', 'String must contain at least 4 character(s)'], ['holderName.0', 'Required'], ['accountNo', 'Invalid']));
    expect(d.fields.map((f) => f.name)).toEqual(['accountNo', 'holderName']);
  });

  it('shows a single Mongolian summary and never leaks a camelCase name or English text', () => {
    const d = describeDisbursementError(validation(['accountNo', 'String must contain at least 4 character(s)'], ['holderName', 'Required']));
    expect(d.message).toBe('Олголтын мэдээлэлд алдаа байна. Улаанаар тэмдэглэсэн талбарыг засаад дахин хадгална уу.');
    for (const text of [d.message, ...d.fields.map((f) => f.message)]) expect(text).not.toMatch(LATIN);
  });

  it('falls back to a Mongolian generic message when no issue maps to a field', () => {
    const d = describeDisbursementError(validation(['unknownField', 'Required']));
    expect(d.fields).toEqual([]);
    expect(d.message).toBe('Оруулсан мэдээлэл хүлээн авагдсангүй. Талбаруудыг шалгаад дахин оролдоно уу.');
  });
});

describe('describeDisbursementError: business and transport errors', () => {
  it('attaches DISBURSE_EXCEEDS_APPROVED (BR-10) to the amount field with the server text', () => {
    const text = 'Олгох дүн батлагдсан дүнгээс (5000000) хэтэрч болохгүй (BR-10)';
    const d = describeDisbursementError(new ApiError(400, 'DISBURSE_EXCEEDS_APPROVED', text));
    expect(d.fields).toEqual([{ name: 'disburseAmount', message: text }]);
  });

  it('shows a Mongolian server message for a state conflict as the summary only', () => {
    const d = describeDisbursementError(new ApiError(409, 'DISBURSEMENT_NOT_EDITABLE', 'Илгээсэн олголтын хүсэлтийг засах боломжгүй'));
    expect(d).toEqual({ message: 'Илгээсэн олголтын хүсэлтийг засах боломжгүй', fields: [] });
  });

  it('replaces an English 4xx server message with the generic Mongolian one', () => {
    const d = describeDisbursementError(new ApiError(422, null, 'Unprocessable Entity'));
    expect(d.fields).toEqual([]);
    expect(d.message).not.toMatch(LATIN);
  });

  it.each([[403], [500]])('uses the shared Mongolian text for status %i', (status) => {
    const d = describeDisbursementError(new ApiError(status, null, 'x'));
    expect(d.fields).toEqual([]);
    expect(d.message.length).toBeGreaterThan(0);
    expect(d.message).not.toMatch(LATIN);
  });

  it('keeps the already-translated text of a network error (status 0)', () => {
    const d = describeDisbursementError(new ApiError(0, 'NETWORK_ERROR', 'Сервертэй холбогдож чадсангүй'));
    expect(d).toEqual({ message: 'Сервертэй холбогдож чадсангүй', fields: [] });
  });

  it('does not throw on null, undefined or a network TypeError', () => {
    for (const e of [null, undefined, new TypeError('Failed to fetch')]) {
      const d = describeDisbursementError(e);
      expect(d.fields).toEqual([]);
      expect(d.message.length).toBeGreaterThan(0);
    }
  });
});
