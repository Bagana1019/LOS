import type { XypCitizen } from '@los/contracts';
import { xypFixture } from './xyp.fixture';
import { XypUnavailableError, type XypClient } from './xyp.client';

/** Deterministic: ижил регистрт ижил хариу; дуудагч өөрчилсөн ч fixture өөрчлөгдөхгүй. */
export class MockXypClient implements XypClient {
  async getCitizen(registerNo: string): Promise<XypCitizen | null> {
    const r = xypFixture(registerNo);
    if (r === undefined) throw new XypUnavailableError();
    return r && structuredClone(r);
  }
}
