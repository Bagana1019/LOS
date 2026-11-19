import type { XypAssetsResponse, XypCitizen, XypPropertyAsset } from '@los/contracts';
import { xypFixture } from './xyp.fixture';
import { xypAssetsFixture, xypPropertyFixture } from './xyp-assets.fixture';
import { XypOtpRejectedError, XypUnavailableError, type XypClient } from './xyp.client';

/**
 * DEMO: Deterministic: ижил регистрт ижил хариу; дуудагч өөрчилсөн ч fixture өөрчлөгдөхгүй.
 * Хөрөнгийн fixture: `xyp-assets.fixture.ts` (valuation-ий mock АТҮТ-тэй тээврийн хэрэгслээр нийцнэ).
 */
/** DEMO: mock горимд иргэний код үргэлж энэ утга (бодит SMS явахгүй). Бодит горимд vendor код илгээнэ. */
export const MOCK_XYP_OTP = '123456';

export class MockXypClient implements XypClient {
  async requestCitizenOtp(registerNo: string): Promise<boolean> {
    const r = xypFixture(registerNo);
    if (r === undefined) throw new XypUnavailableError();
    return r !== null;
  }

  async getCitizen(registerNo: string, otp: string): Promise<XypCitizen | null> {
    const r = xypFixture(registerNo);
    if (r === undefined) throw new XypUnavailableError();
    if (r === null) return null; // регистрийн оршихуйг эхлээд шалгана
    if (otp !== MOCK_XYP_OTP) throw new XypOtpRejectedError();
    return structuredClone(r);
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
