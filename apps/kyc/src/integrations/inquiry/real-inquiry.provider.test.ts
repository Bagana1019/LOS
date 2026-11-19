import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../errors';
import { InquiryRejectedError, InquiryUnavailableError, type ExternalInquirySource } from './inquiry.provider';
import { RealInquiryProvider } from './real-inquiry.provider';

// Real CIB (ЗМС) = SainScore. fetch stub-аар бүтэн урсгал (client + mapper); бодит vendor-т хандаагүй.
const ENV = { SAINSCORE_BASE_URL: 'https://zms.example.test/api', SAINSCORE_USERNAME: 'lender', SAINSCORE_PASSWORD_HASH: 'hash-secret', SAINSCORE_PRODUCT_NO: '13611304' };
const CTX = { contact: { phone: '99112233', email: 'borrower@example.mn' } };
const TODAY = new Date('2025-01-15T00:00:00Z');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const loanRow = { adv_amount: 5_000_000, adv_date: '2024-05-22', balance: 3_500_000, clientname: 'ХААН БАНК', closed_date: null, cls_status: 0, curr_code: 'MNT', dutytype: 'LN', int_rate: 5, maturity_date: '2025-11-08', loancode: 'L-1', colls: [] };

function make(inquiry: () => Response | Error = () => json(200, { responsecode: 'SR0000', responsemsg: 'OK', decision: 'APPROVED', inquiry: [loanRow] }), env: Record<string, string | undefined> = ENV) {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith('/login')) return json(200, { success: true, msg: 'ok', token: 'T' });
    const r = inquiry();
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { provider: new RealInquiryProvider({ env, fetchImpl, now: () => TODAY, sleep: async () => undefined }), calls };
}

describe('RealInquiryProvider — CIB (ЗМС) = SainScore', () => {
  it('регистр, утас, имэйл, productno-г vendor-т дамжуулж, мөрүүдийг LOS summary болгоно', async () => {
    const { provider, calls } = make();
    const r = await provider.fetch('CIB', 'УБ99010203', CTX);
    const inquiryCall = calls.find((c) => c.url.endsWith('/inquiry'))!;
    expect(inquiryCall.body).toMatchObject({ custregno: 'УБ99010203', custphone: '99112233', custemail: 'borrower@example.mn', productno: '13611304' });
    expect(r.summary).toMatchObject({ active_loan_count: 1, outstanding: 3_500_000, total_disbursed: 5_000_000 });
    expect(r.warningLevel).toBe('NONE');
    expect((r.detail.raw as { inquiry: unknown[] }).inquiry).toHaveLength(1);
  });

  it('хугацааг injected цагаар тооцно (үлдсэн сар)', async () => {
    const { provider } = make();
    const r = await provider.fetch('CIB', 'УБ99010203', CTX);
    expect(r.summary.monthly_payment).toBeGreaterThan(350_000); // 10 сар
  });

  it.each([
    ['ctx байхгүй', undefined],
    ['contact байхгүй', {}],
    ['утас хоосон', { contact: { phone: '  ', email: 'a@b.mn' } }],
    ['имэйл null', { contact: { phone: '99112233', email: null } }],
  ])('%s → InquiryRejectedError(CONTACT_REQUIRED), vendor руу ЯМАР Ч дуудлага хийхгүй (төлбөртэй хүсэлтийг дэмий явуулахгүй)', async (_l, ctx) => {
    const { provider, calls } = make();
    const err = await provider.fetch('CIB', 'УБ99010203', ctx).catch((e) => e);
    expect(err).toBeInstanceOf(InquiryRejectedError);
    expect(err.vendorCode).toBe('CONTACT_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('vendor түр ажиллахгүй бол InquiryUnavailableError (inquiry нэг л удаа)', async () => {
    const { provider, calls } = make(() => json(503, {}));
    await expect(provider.fetch('CIB', 'УБ99010203', CTX)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(calls.filter((c) => c.url.endsWith('/inquiry'))).toHaveLength(1);
  });

  it('тохиргоо дутуу (production биш real) → IntegrationNotConfiguredError, дуудлагагүй', async () => {
    const { provider, calls } = make(undefined, { ...ENV, SAINSCORE_PASSWORD_HASH: '' });
    await expect(provider.fetch('CIB', 'УБ99010203', CTX)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it('config өгөгдсөн ч харилцагчийн холбоо барих мэдээлэл дутуу бол config алдаа биш CONTACT_REQUIRED (хоёр шалтгааныг хольдоггүй)', async () => {
    const { provider } = make();
    await expect(provider.fetch('CIB', 'УБ99010203')).rejects.toMatchObject({ vendorCode: 'CONTACT_REQUIRED' });
  });
});

describe('RealInquiryProvider — SainScore-ээр хангагдахгүй эх сурвалжууд fail-closed', () => {
  it.each(['FICO', 'DTI', 'LIVESTOCK', 'XYP_PROPERTY', 'XYP_VEHICLE', 'XYP_PENSION', 'XYP_LEGAL', 'XYP_CRIMINAL', 'XYP_COURT_DEBT'] as ExternalInquirySource[])('%s → IntegrationNotImplementedError, зохиомол хариу/HTTP дуудлагагүй', async (source) => {
    const { provider, calls } = make();
    const err = await provider.fetch(source, 'УБ99010203', CTX).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationNotImplementedError);
    expect(err.integration).toBe(`inquiry:${source}`);
    expect(calls).toHaveLength(0);
  });
});
