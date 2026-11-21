import { customerTypeOfRegister, type CustomerLookup, type CustomerType, type XypFetchResult } from '@los/contracts';

/**
 * F1-16: «Иргэний зөвшөөрөл» (ХУР иргэний БҮРТГЭЛТЭЙ утсанд очдог нэг удаагийн код) нь зөвхөн иргэнд хамаарна.
 * Байгууллагад иргэний утас байхгүй; бодит ХУР-ын клиент 7 оронтой регистрт 501 `INTEGRATION_NOT_IMPLEMENTED` буцаана (docs/DECISIONS.md 2026-11-19),
 * зөвхөн mock клиент fixture-ээр нэвтрүүлдэг. Тиймээс ААН-д код хүсэхгүй, зөвхөн `GET /customers/lookup`-ээр бүртгэлтэй эсэх + хар жагсаалтыг шалгана.
 */
export const usesCitizenOtp = (type: CustomerType): boolean => type === 'INDIVIDUAL';

/** `lookup`-ийн хариуг маягтын `XypFetchResult` хэлбэрт оруулна (ХУР дуудаагүй: `fetchedAt`/`snapshotToken` = null → `source=MANUAL`). */
export function lookupToFetchResult(l: CustomerLookup): XypFetchResult {
  const customerType = l.customerType ?? customerTypeOfRegister(l.registerNo);
  if (!customerType) throw new Error(`Регистрийн төрөл танигдсангүй: ${l.registerNo.length} тэмдэгт`);
  return { registerNo: l.registerNo, customerType, fetchedAt: null, prefill: {}, prefilledFields: [], missing: [], existing: l.customer, warnings: l.warnings, snapshotToken: null };
}
