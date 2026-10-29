// АНХААР: энэ өгөгдөл ЖИШЭЭ (illustrative, NOT authoritative) бөгөөд FATF-ийн албан ёсны жагсаалт БИШ — зөвхөн mock/тестэд.
// Бодит жагсаалтыг RealFatfClient-ээр солино (FATF-ийн хуралдаан бүрийн дараа шинэчилнэ). Үүнийг compliance шийдвэрийн эх сурвалж болгож болохгүй.
// Монгол (MN) санаатайгаар ороогүй — өөрийн улсаар тулгах тохиолдол CLEAR байх ёстой.
import type { FatfSnapshot } from './fatf.client';

export const FATF_FIXTURE: FatfSnapshot = {
  version: 'mock-2026-10',
  publishedAt: '2026-10-24T00:00:00.000Z',
  entries: [
    { countryCode: 'KP', countryName: "Korea, Democratic People's Republic of", category: 'CALL_FOR_ACTION', listedOn: '2026-10-23' },
    { countryCode: 'IR', countryName: 'Iran, Islamic Republic of', category: 'CALL_FOR_ACTION', listedOn: '2026-10-23' },
    { countryCode: 'MM', countryName: 'Myanmar', category: 'CALL_FOR_ACTION', listedOn: '2026-10-23' },
    { countryCode: 'KE', countryName: 'Kenya', category: 'INCREASED_MONITORING', listedOn: '2026-02-20' },
    { countryCode: 'VN', countryName: 'Viet Nam', category: 'INCREASED_MONITORING', listedOn: '2026-06-13' },
    { countryCode: 'LA', countryName: "Lao People's Democratic Republic", category: 'INCREASED_MONITORING', listedOn: '2026-06-13' },
    { countryCode: 'HT', countryName: 'Haiti', category: 'INCREASED_MONITORING', listedOn: '2026-02-20' },
    { countryCode: 'YE', countryName: 'Yemen', category: 'INCREASED_MONITORING', listedOn: '2026-10-23' },
    { countryCode: 'SS', countryName: 'South Sudan', category: 'INCREASED_MONITORING', listedOn: '2026-02-20' },
  ],
};
