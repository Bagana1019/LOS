import { DomainError } from '@los/nest-common';
import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../../integrations/errors';
import { XypUnavailableError, type XypClient } from '../../integrations/xyp/xyp.client';
import { XypController } from './xyp.controller';

// ХУР-ын клиентийн алдааг HTTP болгох: хэрэглэгчид зориулсан тогтвортой (Монгол) кодууд. origination-ийн жагсаалт хаалттай тул шинэ код нэмэхгүй.
const REG = 'УБ90010112';
const failing = (e: Error): XypClient => ({ getCitizen: async () => { throw e; }, getAssets: async () => { throw e; }, getProperty: async () => { throw e; } });
const errorOf = async (p: Promise<unknown>): Promise<DomainError> => { try { await p; } catch (e) { return e as DomainError; } throw new Error('expected a rejection'); };

describe('XypController error mapping', () => {
  it('XypUnavailableError → 503 XYP_UNAVAILABLE', async () => {
    const e = await errorOf(new XypController(failing(new XypUnavailableError())).citizen({ registerNo: REG }));
    expect([e.code, e.getStatus()]).toEqual(['XYP_UNAVAILABLE', 503]);
  });

  it('IntegrationNotImplementedError → 501 INTEGRATION_NOT_IMPLEMENTED', async () => {
    const e = await errorOf(new XypController(failing(new IntegrationNotImplementedError('xyp:assets'))).assets({ registerNo: REG }));
    expect([e.code, e.getStatus()]).toEqual(['INTEGRATION_NOT_IMPLEMENTED', 501]);
  });

  it('IntegrationNotConfiguredError → 503 XYP_UNAVAILABLE (хэрэглэгч «гараар бөглөх» замаа авна); env-ийн нэр, нууц гарахгүй', async () => {
    const cause = new IntegrationNotConfiguredError('xyp', ['XYP_ACCESS_TOKEN', 'XYP_PRIVATE_KEY_PATH']);
    for (const call of [
      (c: XypController) => c.citizen({ registerNo: REG }),
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
    const e = await errorOf(new XypController(failing(new Error('boom'))).citizen({ registerNo: REG }));
    expect(e).not.toBeInstanceOf(DomainError);
  });
});
