import { DomainError } from '@los/nest-common';
import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../../integrations/errors';
import { XypOtpRejectedError, XypUnavailableError, type XypClient } from '../../integrations/xyp/xyp.client';
import { XypController } from './xyp.controller';

// ХУР-ын клиентийн алдааг HTTP болгох: хэрэглэгчид зориулсан тогтвортой (Монгол) кодууд. origination-ийн жагсаалт хаалттай тул шинэ код нэмэхгүй.
const REG = 'УБ90010112';
const OTP = '123456';
const failing = (e: Error): XypClient => ({ requestCitizenOtp: async () => { throw e; }, getCitizen: async () => { throw e; }, getAssets: async () => { throw e; }, getProperty: async () => { throw e; } });
const errorOf = async (p: Promise<unknown>): Promise<DomainError> => { try { await p; } catch (e) { return e as DomainError; } throw new Error('expected a rejection'); };

describe('XypController · иргэний код (OTP)', () => {
  const ok = (over: Partial<XypClient> = {}): XypClient => ({ requestCitizenOtp: async () => true, getCitizen: async () => null, getAssets: async () => null, getProperty: async () => null, ...over });

  it('citizenOtp: код илгээгдвэл { sent: true, requestedAt: ISO }', async () => {
    const res = await new XypController(ok()).citizenOtp({ registerNo: REG });
    expect(res.sent).toBe(true);
    expect(new Date(res.requestedAt).toISOString()).toBe(res.requestedAt);
  });

  it('citizenOtp: регистр олдохгүй → 404 XYP_NOT_FOUND', async () => {
    const e = await errorOf(new XypController(ok({ requestCitizenOtp: async () => false })).citizenOtp({ registerNo: REG }));
    expect([e.code, e.getStatus()]).toEqual(['XYP_NOT_FOUND', 404]);
  });

  it('citizenOtp: регистрийн хэлбэр буруу → 400 INVALID_REGISTER_NO, ХУР-д хүрэхгүй', async () => {
    let called = false;
    const e = await errorOf(new XypController(ok({ requestCitizenOtp: async () => { called = true; return true; } })).citizenOtp({ registerNo: 'garbage' }));
    expect([e.code, e.getStatus(), called]).toEqual(['INVALID_REGISTER_NO', 400, false]);
  });

  it('citizen: код буруу / хугацаа дууссан (XypOtpRejectedError) → 422 XYP_OTP_INVALID, хэрэглэгчид шинэ код авахыг зөвлөнө', async () => {
    const e = await errorOf(new XypController(failing(new XypOtpRejectedError())).citizen({ registerNo: REG, otp: OTP }));
    expect([e.code, e.getStatus()]).toEqual(['XYP_OTP_INVALID', 422]);
    expect(e.message).not.toContain(OTP);
  });

  it('citizen: ХУР унасан үед 503 XYP_UNAVAILABLE (код буруу биш), citizenOtp-д ч мөн адил', async () => {
    const down = new XypController(failing(new XypUnavailableError()));
    expect((await errorOf(down.citizen({ registerNo: REG, otp: OTP }))).code).toBe('XYP_UNAVAILABLE');
    expect((await errorOf(down.citizenOtp({ registerNo: REG }))).code).toBe('XYP_UNAVAILABLE');
  });

  it('citizen: олдохгүй → 404 XYP_NOT_FOUND', async () => {
    const e = await errorOf(new XypController(ok()).citizen({ registerNo: REG, otp: OTP }));
    expect([e.code, e.getStatus()]).toEqual(['XYP_NOT_FOUND', 404]);
  });
});

describe('XypController error mapping', () => {
  it('XypUnavailableError → 503 XYP_UNAVAILABLE', async () => {
    const e = await errorOf(new XypController(failing(new XypUnavailableError())).citizen({ registerNo: REG, otp: OTP }));
    expect([e.code, e.getStatus()]).toEqual(['XYP_UNAVAILABLE', 503]);
  });

  it('IntegrationNotImplementedError → 501 INTEGRATION_NOT_IMPLEMENTED', async () => {
    const e = await errorOf(new XypController(failing(new IntegrationNotImplementedError('xyp:assets'))).assets({ registerNo: REG }));
    expect([e.code, e.getStatus()]).toEqual(['INTEGRATION_NOT_IMPLEMENTED', 501]);
  });

  it('IntegrationNotConfiguredError → 503 XYP_UNAVAILABLE (хэрэглэгч «гараар бөглөх» замаа авна); env-ийн нэр, нууц гарахгүй', async () => {
    const cause = new IntegrationNotConfiguredError('xyp', ['XYP_ACCESS_TOKEN', 'XYP_PRIVATE_KEY_PATH']);
    for (const call of [
      (c: XypController) => c.citizen({ registerNo: REG, otp: OTP }),
      (c: XypController) => c.assets({ registerNo: REG }),
      (c: XypController) => c.property({ propertyId: 'P-1' }),
    ]) {
      const e = await errorOf(call(new XypController(failing(cause))));
      expect([e.code, e.getStatus()]).toEqual(['XYP_UNAVAILABLE', 503]);
      expect(e.message).not.toContain('XYP_ACCESS_TOKEN');
      expect(e.message).not.toContain('XYP_PRIVATE_KEY_PATH');
    }
  });

  it('танигдаагүй алдааг дотоод мэдээлэлтэй нь хамт хэрэглэгчид тусгахгүй (шууд дамжуулна, controller хувиргахгүй)', async () => {
    const e = await errorOf(new XypController(failing(new Error('boom'))).citizen({ registerNo: REG, otp: OTP }));
    expect(e).not.toBeInstanceOf(DomainError);
  });
});
