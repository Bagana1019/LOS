import type { XypAssetsResponse, XypCitizen, XypPropertyAsset } from '@los/contracts';
import { xypFixture } from './xyp.fixture';
import { xypAssetsFixture, xypPropertyFixture } from './xyp-assets.fixture';
import { XypUnavailableError, type XypClient } from './xyp.client';

/**
 * DEMO: Deterministic: ижил регистрт ижил хариу; дуудагч өөрчилсөн ч fixture өөрчлөгдөхгүй.
 * Хөрөнгийн fixture: `xyp-assets.fixture.ts` (valuation-ий mock АТҮТ-тэй тээврийн хэрэгслээр нийцнэ).
 */
export class MockXypClient implements XypClient {
  async getCitizen(registerNo: string): Promise<XypCitizen | null> {
    const r = xypFixture(registerNo);
    if (r === undefined) throw new XypUnavailableError();
    return r && structuredClone(r);
  }

  async getAssets(registerNo: string): Promise<XypAssetsResponse | null> {
    const r = xypAssetsFixture(registerNo);
    if (r === undefined) throw new XypUnavailableError();
    return r; // fixture дуудалт бүрт шинээр бүтдэг (хуваалцсан объект буцаахгүй)
  }

  async getProperty(propertyId: string): Promise<XypPropertyAsset | null> {
    const r = xypPropertyFixture(propertyId);
    if (r === undefined) throw new XypUnavailableError();
    return r;
  }
}
