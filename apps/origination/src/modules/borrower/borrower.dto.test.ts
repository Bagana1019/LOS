import { describe, expect, it } from 'vitest';
import { AddBorrowerRequest, BorrowerCandidatesQuery, BorrowerErrorCode, BorrowerListResponse, MAX_GUARANTEE_AMOUNT, RecordConsentRequest, UpdateBorrowerRequest } from '@los/contracts';

// @los/contracts-ийн borrower DTO-ийн нөхцөлт шалгалт (HTTP-ийн 400 VALIDATION_FAILED-ийн суурь).
const issues = (r: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }) => (r.success ? [] : r.error?.issues.map((i) => i.path.join('.')) ?? []);

describe('AddBorrowerRequest', () => {
  const base = { customerId: 'c1' };
  it('зөв хослолууд', () => {
    for (const body of [
      { ...base, role: 'PRIMARY' }, { ...base, role: 'CO_BORROWER', liabilityShare: 0.5, relationToPrimary: 'SPOUSE', incomeIncluded: false },
      { ...base, role: 'GUARANTOR' }, { ...base, role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL' }, { ...base, role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 1000 },
      { ...base, role: 'PLEDGOR', relationToPrimary: 'FRIEND', note: 'тэмдэглэл' }, { ...base, role: 'CO_BORROWER', liabilityShare: 0.0001 }, { ...base, role: 'CO_BORROWER', liabilityShare: 1 },
      { ...base, role: 'CO_BORROWER', liabilityShare: null, guaranteeType: null, guaranteeAmount: null, relationToPrimary: null, note: null },
    ]) expect(AddBorrowerRequest.safeParse(body).success, JSON.stringify(body)).toBe(true);
  });
  it('буруу хослолууд', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...base, role: 'PRIMARY', relationToPrimary: 'SPOUSE' }, 'relationToPrimary'],
      [{ ...base, role: 'PRIMARY', liabilityShare: 0.5 }, 'liabilityShare'],
      [{ ...base, role: 'GUARANTOR', liabilityShare: 0.5 }, 'liabilityShare'],
      [{ ...base, role: 'CO_BORROWER', guaranteeType: 'LIMITED', guaranteeAmount: 5 }, 'guaranteeType'],
      [{ ...base, role: 'GUARANTOR', guaranteeType: 'LIMITED' }, 'guaranteeAmount'],
      [{ ...base, role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: 5 }, 'guaranteeAmount'],
      [{ ...base, role: 'GUARANTOR', guaranteeAmount: 5 }, 'guaranteeType'],
      [{ ...base, role: 'CO_BORROWER', liabilityShare: 0 }, 'liabilityShare'],
      [{ ...base, role: 'CO_BORROWER', liabilityShare: 0.00009 }, 'liabilityShare'],
      [{ ...base, role: 'CO_BORROWER', liabilityShare: 1.0001 }, 'liabilityShare'],
      [{ role: 'PRIMARY' }, 'customerId'], [{ ...base, customerId: '', role: 'PRIMARY' }, 'customerId'], [{ ...base, role: 'OWNER' }, 'role'],
    ];
    for (const [body, path] of bad) expect(issues(AddBorrowerRequest.safeParse(body)), JSON.stringify(body)).toContain(path);
  });
});

describe('guaranteeAmount: төгсгөлөг ба дээд хязгаартай (Infinity нь NULL болж хадгалагддаг, ≥1e16 нь numeric(18,2) overflow)', () => {
  const add = (guaranteeAmount: number) => ({ customerId: 'c1', role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount });
  // JSON `1e999` нь JSON.parse-аар Infinity болно — HTTP-ийн бодит оролт.
  const parsed = JSON.parse('{"guaranteeAmount":1e999}') as { guaranteeAmount: number };
  it('JSON 1e999 → Infinity гэдгийг баталгаажуулна', () => { expect(parsed.guaranteeAmount).toBe(Infinity); });
  it.each([['Infinity', parsed.guaranteeAmount], ['-Infinity', -Infinity], ['NaN', NaN], ['хязгаараас 0.01-ээр их', MAX_GUARANTEE_AMOUNT + 0.01], ['1e13', 1e13], ['1e16', 1e16], ['1e17', 1e17]])('нэмэх ба засах: %s → татгалзана', (_n, v) => {
    expect(issues(AddBorrowerRequest.safeParse(add(v)))).toContain('guaranteeAmount');
    expect(issues(UpdateBorrowerRequest.safeParse({ guaranteeType: 'LIMITED', guaranteeAmount: v }))).toContain('guaranteeAmount');
  });
  it.each([0.01, 1, 2_000_000, 1e12, MAX_GUARANTEE_AMOUNT])('нэмэх ба засах: %s → зөвшөөрнө', (v) => {
    expect(AddBorrowerRequest.safeParse(add(v)).success).toBe(true);
    expect(UpdateBorrowerRequest.safeParse({ guaranteeType: 'LIMITED', guaranteeAmount: v }).success).toBe(true);
  });
  it('хязгаар нь numeric(18,2)-д багтаж, төгрөгийн 1/100 хөвөгч таслалтгүй бүхэл хэвээр үлдэнэ', () => {
    expect(MAX_GUARANTEE_AMOUNT).toBeLessThan(1e16);
    expect(Number.isSafeInteger(Math.round(MAX_GUARANTEE_AMOUNT * 100))).toBe(true);
  });
});

describe('UpdateBorrowerRequest / RecordConsentRequest / BorrowerCandidatesQuery', () => {
  it('PATCH: хоосон биет буруу, null арилгах утга зөв, incomeIncluded null буруу', () => {
    expect(UpdateBorrowerRequest.safeParse({}).success).toBe(false);
    expect(UpdateBorrowerRequest.safeParse({ note: null, liabilityShare: null, relationToPrimary: null, guaranteeType: null, guaranteeAmount: null }).success).toBe(true);
    expect(UpdateBorrowerRequest.safeParse({ guaranteeType: 'LIMITED' }).success).toBe(true); // нэгтгэсэн төлвийг сервис шалгана
    expect(UpdateBorrowerRequest.safeParse({ incomeIncluded: null }).success).toBe(false);
  });
  it('consent: ISO instant ба fileId', () => {
    expect(RecordConsentRequest.safeParse({ fileId: 'f', signedAt: '2026-10-27T09:00:00Z' }).success).toBe(true);
    expect(RecordConsentRequest.safeParse({ fileId: 'f', signedAt: '2026-10-27' }).success).toBe(false);
    expect(RecordConsentRequest.safeParse({ fileId: '', signedAt: '2026-10-27T09:00:00Z' }).success).toBe(false);
  });
  it('candidates query: registerNo тримлэгдэнэ', () => {
    expect(BorrowerCandidatesQuery.parse({ registerNo: '  УБ90000012 ' })).toEqual({ registerNo: 'УБ90000012' });
    expect(BorrowerCandidatesQuery.safeParse({ registerNo: '   ' }).success).toBe(false);
    expect(BorrowerCandidatesQuery.safeParse({}).success).toBe(false);
  });
});

describe('BorrowerListResponse / BorrowerErrorCode', () => {
  it('хоосон жагсаалт зөв хэлбэртэй', () => {
    const empty = { items: [], warnings: [], summary: { primaryCount: 0, coBorrowerCount: 0, guarantorCount: 0, pledgorCount: 0, clientStepComplete: false, primaryLiabilityShare: null, incomeContributorCustomerIds: [], guaranteeCoverageRatio: null, limits: { maxCoBorrowers: 3, maxGuarantors: 3 }, editable: true } };
    expect(BorrowerListResponse.parse(empty)).toEqual(empty);
  });
  it('алдааны кодууд давхардалгүй', () => {
    expect(new Set(BorrowerErrorCode).size).toBe(BorrowerErrorCode.length);
  });
});
