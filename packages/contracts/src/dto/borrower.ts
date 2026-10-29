import { z } from 'zod';
import { BorrowerRole, BorrowerRelation, BorrowerWarningCode, CustomerType, GuaranteeType } from '../enums';

// FR-2.1: нэг хүсэлтэд олон зээлдэгч (үндсэн, хамтран, батлан даагч, барьцаалагч). docs/03 loan_application_borrower.
// Хамтран зээлдэгч = зээлийн төлбөрийг хамтран хариуцна (орлого нэгтгэгдэнэ, BSA-BR-9).
// Батлан даагч = үндсэн зээлдэгч төлөөгүй үед хариуцна (орлого нэгтгэгдэхгүй).
// 4 орон (numeric(7,4)) — үүнээс бага хувь DB-д 0 болж алдагдана.
const share = z.number().min(0.0001).lte(1);
// Баталгааны дээд дүн: numeric(18,2)-д багтах (<1e16) ба төгрөгийн 1/100-ийг хөвөгч таслалтгүй (Number.MAX_SAFE_INTEGER) тооцохоор хязгаарлана.
// JSON `1e999` нь Infinity болж parse хийгддэг тул `.finite()` заавал (ингэхгүй бол LIMITED баталгаа дүнгүй NULL болж хадгалагдана).
export const MAX_GUARANTEE_AMOUNT = 9_999_999_999_999.99;
const guaranteeAmountField = z.number().finite().positive().max(MAX_GUARANTEE_AMOUNT);

const guaranteeRules = (v: { role?: string; relationToPrimary?: string | null; liabilityShare?: number | null; guaranteeType?: string | null; guaranteeAmount?: number | null }, ctx: z.RefinementCtx) => {
  if (v.relationToPrimary != null && v.role === 'PRIMARY')
    ctx.addIssue({ code: 'custom', path: ['relationToPrimary'], message: 'relationToPrimary үндсэн зээлдэгчид байхгүй' });
  if (v.liabilityShare != null && v.role !== undefined && v.role !== 'CO_BORROWER')
    ctx.addIssue({ code: 'custom', path: ['liabilityShare'], message: 'liabilityShare зөвхөн CO_BORROWER-д' });
  if ((v.guaranteeType != null || v.guaranteeAmount != null) && v.role !== undefined && v.role !== 'GUARANTOR')
    ctx.addIssue({ code: 'custom', path: ['guaranteeType'], message: 'guaranteeType/guaranteeAmount зөвхөн GUARANTOR-д' });
  if (v.guaranteeAmount != null && v.guaranteeType == null)
    ctx.addIssue({ code: 'custom', path: ['guaranteeType'], message: 'guaranteeAmount өгвөл guaranteeType заавал' });
  if (v.guaranteeType === 'LIMITED' && v.guaranteeAmount == null)
    ctx.addIssue({ code: 'custom', path: ['guaranteeAmount'], message: 'LIMITED баталгаанд guaranteeAmount заавал' });
  if (v.guaranteeType === 'JOINT_AND_SEVERAL' && v.guaranteeAmount != null)
    ctx.addIssue({ code: 'custom', path: ['guaranteeAmount'], message: 'JOINT_AND_SEVERAL баталгаанд guaranteeAmount байхгүй' });
};

export const AddBorrowerRequest = z
  .object({
    customerId: z.string().min(1),
    role: z.enum(BorrowerRole),
    relationToPrimary: z.enum(BorrowerRelation).nullish(),
    liabilityShare: share.nullish(),
    guaranteeType: z.enum(GuaranteeType).nullish(),
    guaranteeAmount: guaranteeAmountField.nullish(),
    incomeIncluded: z.boolean().optional(),
    note: z.string().max(1000).nullish(),
  })
  .superRefine(guaranteeRules);
export type AddBorrowerRequest = z.infer<typeof AddBorrowerRequest>;

// Дүрийг (role) өөрчлөх боломжгүй: устгаад дахин нэмнэ. Үндсэнийг солих → make-primary.
export const UpdateBorrowerRequest = z
  .object({
    relationToPrimary: z.enum(BorrowerRelation).nullish(),
    liabilityShare: share.nullish(),
    guaranteeType: z.enum(GuaranteeType).nullish(),
    guaranteeAmount: guaranteeAmountField.nullish(),
    incomeIncluded: z.boolean().optional(),
    note: z.string().max(1000).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Хоосон өөрчлөлт' });
export type UpdateBorrowerRequest = z.infer<typeof UpdateBorrowerRequest>;

export const RecordConsentRequest = z.object({ fileId: z.string().min(1), signedAt: z.string().datetime() });
export type RecordConsentRequest = z.infer<typeof RecordConsentRequest>;

export const BorrowerCustomerView = z.object({
  id: z.string(),
  customerType: z.enum(CustomerType),
  displayName: z.string(),
  registerNoMasked: z.string(), // жишээ: УБ******12 — бүтэн регистрийг буцаахгүй (NFR-5)
  phone: z.string().nullable(),
  email: z.string().nullable(),
  isPep: z.boolean(),
  isRelatedParty: z.boolean(),
});
export type BorrowerCustomerView = z.infer<typeof BorrowerCustomerView>;

export const BorrowerWarning = z.object({
  code: z.enum(BorrowerWarningCode),
  message: z.string(),
  customerId: z.string().nullable(),
  details: z.record(z.unknown()).optional(),
});
export type BorrowerWarning = z.infer<typeof BorrowerWarning>;

export const BorrowerView = z.object({
  id: z.string(),
  applicationId: z.string(),
  customerId: z.string(),
  role: z.enum(BorrowerRole),
  isPrimary: z.boolean(),
  relationToPrimary: z.enum(BorrowerRelation).nullable(),
  liabilityShare: z.number().nullable(),
  guaranteeType: z.enum(GuaranteeType).nullable(),
  guaranteeAmount: z.number().nullable(),
  consentFileId: z.string().nullable(),
  consentSignedAt: z.string().datetime().nullable(),
  incomeIncluded: z.boolean(),
  note: z.string().nullable(),
  customer: BorrowerCustomerView,
  createdAt: z.string().datetime(),
});
export type BorrowerView = z.infer<typeof BorrowerView>;

export const BorrowerSummary = z.object({
  primaryCount: z.number().int(),
  coBorrowerCount: z.number().int(),
  guarantorCount: z.number().int(),
  pledgorCount: z.number().int(),
  clientStepComplete: z.boolean(), // §5.1: ≥1 үндсэн зээлдэгч бүртгэгдсэн
  // Үндсэн зээлдэгчийн хариуцах хувь = 1 − Σ(хамтран зээлдэгчийн хувь) (үлдэгдэл, хадгалагдахгүй). Хувь тогтоосон хамтран зээлдэгч байхгүй (хамтын хариуцлага) эсвэл үндсэн зээлдэгч байхгүй бол null.
  primaryLiabilityShare: z.number().nullable(),
  incomeContributorCustomerIds: z.array(z.string()), // тооцоолол/BSA орлого нэгтгэх харилцагчид
  guaranteeCoverageRatio: z.number().nullable(), // Σ баталгааны дүн ÷ зээлийн дүн (JOINT_AND_SEVERAL = бүтэн дүн)
  limits: z.object({ maxCoBorrowers: z.number().int(), maxGuarantors: z.number().int() }),
  editable: z.boolean(), // DRAFT / RETURNED төлөвт л засна
});
export type BorrowerSummary = z.infer<typeof BorrowerSummary>;

export const BorrowerListResponse = z.object({ items: z.array(BorrowerView), summary: BorrowerSummary, warnings: z.array(BorrowerWarning) });
export type BorrowerListResponse = z.infer<typeof BorrowerListResponse>;

export const BorrowerMutationResponse = z.object({ borrower: BorrowerView, summary: BorrowerSummary, warnings: z.array(BorrowerWarning) });
export type BorrowerMutationResponse = z.infer<typeof BorrowerMutationResponse>;

// GET applications/:applicationId/borrowers/candidates?registerNo= — регистрээр (blind index) байгаа харилцагч хайх.
export const BorrowerCandidatesQuery = z.object({ registerNo: z.string().trim().min(1).max(32) });
export type BorrowerCandidatesQuery = z.infer<typeof BorrowerCandidatesQuery>;

export const BorrowerCandidate = z.object({
  customerId: z.string(),
  displayName: z.string(),
  registerNoMasked: z.string(),
  customerType: z.enum(CustomerType),
  phone: z.string().nullable(),
  linkedRoles: z.array(z.enum(BorrowerRole)), // энэ хүсэлтэд тус харилцагч аль хэдийн хаана оролцож буй
});
export type BorrowerCandidate = z.infer<typeof BorrowerCandidate>;

// Алдааны `code` (HTTP хариуны { code, message }) — UI монгол мессежээр харуулахад ашиглана.
export const BorrowerErrorCode = [
  'VALIDATION_FAILED', 'APPLICATION_NOT_FOUND', 'BORROWER_NOT_FOUND', 'CUSTOMER_NOT_FOUND',
  'APPLICATION_NOT_EDITABLE', 'PRIMARY_EXISTS', 'PRIMARY_REQUIRED', 'BORROWER_DUPLICATE', 'ROLE_CONFLICT', 'LIMIT_EXCEEDED', 'BORROWER_OWNS_COLLATERAL', 'NOT_CO_BORROWER',
  'LIABILITY_SHARE_EXCEEDED', 'ENTITY_CANNOT_CO_BORROW', 'FIELD_NOT_ALLOWED_FOR_ROLE', 'INCOME_NOT_ALLOWED', 'GUARANTEE_INVALID', 'CONSENT_SIGNED_IN_FUTURE',
] as const;
export type BorrowerErrorCode = typeof BorrowerErrorCode[number];
