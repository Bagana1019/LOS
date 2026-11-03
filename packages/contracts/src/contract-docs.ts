import { z } from 'zod';
import { AccountOwnerType, ContractTemplateType, DisbursementStatus, RepaymentType } from './enums';

// Модуль 11 · FR-11 гэрээ/ЭТХ/албан бичгийн загвар (dms), FR-12 олголтын хүсэлт (origination). Сервис хоорондын цорын ганц гэрээ.

/** FR-11.2 загварын placeholder-ийн каталог. Docx доторх `{{key}}`; давталт: `{{#schedule}}…{{/schedule}}` (хүснэгтийн мөр). */
export const PLACEHOLDER_GROUPS = ['CONTRACT', 'CUSTOMER', 'BRANCH', 'COLLATERAL', 'SIGNATURE', 'SCHEDULE', 'REPRESENTATIVE'] as const;
export type PlaceholderGroup = typeof PLACEHOLDER_GROUPS[number];

export interface PlaceholderDef { key: string; group: PlaceholderGroup; label: string; loop?: boolean }
export const PLACEHOLDER_CATALOG: readonly PlaceholderDef[] = [
  { key: 'contract_no', group: 'CONTRACT', label: 'Гэрээний дугаар' },
  { key: 'contract_date', group: 'CONTRACT', label: 'Гэрээний огноо' },
  { key: 'decision_no', group: 'CONTRACT', label: 'Шийдвэрийн дугаар' },
  { key: 'product_name', group: 'CONTRACT', label: 'Бүтээгдэхүүн' },
  { key: 'approved_amount', group: 'CONTRACT', label: 'Батлагдсан дүн' },
  { key: 'currency', group: 'CONTRACT', label: 'Валют' },
  { key: 'term_months', group: 'CONTRACT', label: 'Хугацаа (сар)' },
  { key: 'interest_rate', group: 'CONTRACT', label: 'Жилийн хүү (%)' },
  { key: 'repayment_type', group: 'CONTRACT', label: 'Эргэн төлөлтийн арга' },
  { key: 'first_payment_date', group: 'CONTRACT', label: 'Эхний төлбөрийн огноо' },
  { key: 'borrower_name', group: 'CUSTOMER', label: 'Зээлдэгчийн нэр' },
  { key: 'borrower_register', group: 'CUSTOMER', label: 'Зээлдэгчийн регистр' },
  { key: 'borrower_phone', group: 'CUSTOMER', label: 'Зээлдэгчийн утас' },
  { key: 'borrower_address', group: 'CUSTOMER', label: 'Зээлдэгчийн хаяг' },
  { key: 'co_borrower_names', group: 'CUSTOMER', label: 'Хамтран зээлдэгчид' },
  { key: 'branch_name', group: 'BRANCH', label: 'Салбарын нэр' },
  { key: 'officer_name', group: 'BRANCH', label: 'Зээлийн эксперт' },
  { key: 'collateral_summary', group: 'COLLATERAL', label: 'Барьцааны товч' },
  { key: 'collaterals', group: 'COLLATERAL', label: 'Барьцааны жагсаалт (давталт: description, value, registry_no)', loop: true },
  { key: 'signer_name', group: 'SIGNATURE', label: 'Гарын үсэг зурагчийн нэр' },
  { key: 'sign_date', group: 'SIGNATURE', label: 'Гарын үсгийн огноо' },
  { key: 'schedule', group: 'SCHEDULE', label: 'ЭТХ-ийн мөр (давталт: no, due_date, principal, interest, total, balance)', loop: true },
  { key: 'total_interest', group: 'SCHEDULE', label: 'Нийт хүү' },
  { key: 'total_payment', group: 'SCHEDULE', label: 'Нийт төлөлт' },
  { key: 'org_name', group: 'REPRESENTATIVE', label: 'ББСБ-ын нэр' },
  { key: 'representative_name', group: 'REPRESENTATIVE', label: 'Төлөөлөгчийн нэр' },
  { key: 'representative_title', group: 'REPRESENTATIVE', label: 'Төлөөлөгчийн албан тушаал' },
  { key: 'letter_no', group: 'CONTRACT', label: 'Албан бичгийн дугаар' },
  { key: 'letter_date', group: 'CONTRACT', label: 'Албан бичгийн огноо' },
];

const scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
/** Загварт дүүргэх өгөгдөл: хавтгай талбар + давталтын массив (`schedule`, `collaterals`). Байхгүй placeholder хоосон болно. */
export const TemplateData = z.record(z.string().max(60), z.union([scalar, z.array(z.record(z.string().max(60), scalar)).max(600)]));
export type TemplateData = z.infer<typeof TemplateData>;

export const RenderTemplateRequest = z.object({
  templateId: z.string().uuid().optional(),
  type: z.enum(ContractTemplateType),
  /** templateId өгөөгүй бол: бүтээгдэхүүний идэвхтэй загвар, байхгүй бол productId=null (нийтлэг) загвар */
  productId: z.string().max(64).nullable().optional(),
  data: TemplateData,
  /** Гарсан файлын нэрийн үндэс (өргөтгөлгүй) */
  fileBaseName: z.string().min(1).max(80).default('document'),
});
export type RenderTemplateRequest = z.input<typeof RenderTemplateRequest>;

export const RenderTemplateResponse = z.object({
  templateId: z.string(), templateVersion: z.number().int(), docxFileId: z.string(), pdfFileId: z.string(),
});
export type RenderTemplateResponse = z.infer<typeof RenderTemplateResponse>;

export const ContractTemplateView = z.object({
  id: z.string(), productId: z.string().nullable(), type: z.enum(ContractTemplateType), name: z.string(), docxFileId: z.string(),
  placeholders: z.array(z.string()), unknownPlaceholders: z.array(z.string()), version: z.number().int(), isActive: z.boolean(), createdAt: z.string(),
});
export type ContractTemplateView = z.infer<typeof ContractTemplateView>;

// ── origination: FR-11 гэрээ, албан бичиг ──
export const ContractView = z.object({
  id: z.string(), applicationId: z.string(), contractNo: z.string(), templateVersion: z.number().int().nullable(),
  generatedFileId: z.string().nullable(), signedFileId: z.string().nullable(), signedAt: z.string().nullable(),
  signChannel: z.enum(['PAPER', 'ESIGN']), signingStatus: z.string().nullable(),
});
export type ContractView = z.infer<typeof ContractView>;

export const AttachSignedContractRequest = z.object({ fileId: z.string().min(1).max(64) });
export type AttachSignedContractRequest = z.infer<typeof AttachSignedContractRequest>;

export const CreateOfficialLetterRequest = z.object({
  templateId: z.string().uuid().optional(),
  /** Албан бичгийн нэмэлт талбар (letter_no, representative_name …) */
  extra: z.record(z.string().max(60), z.string().max(2000)).default({}),
});
export type CreateOfficialLetterRequest = z.input<typeof CreateOfficialLetterRequest>;

export const OfficialLetterView = z.object({
  id: z.string(), applicationId: z.string(), templateId: z.string(), generatedFileId: z.string().nullable(), printedAt: z.string().nullable(), createdAt: z.string(),
});
export type OfficialLetterView = z.infer<typeof OfficialLetterView>;

// ── origination: FR-12 олголтын хүсэлт ──
export const UpdateDisbursementRequest = z.object({
  disburseAmount: z.number().positive().optional(),
  disburseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bankCode: z.string().min(1).max(20).optional(),
  accountNo: z.string().min(4).max(34).optional(),
  holderName: z.string().min(1).max(200).optional(),
  accountOwnerType: z.enum(AccountOwnerType).optional(),
});
export type UpdateDisbursementRequest = z.infer<typeof UpdateDisbursementRequest>;

export const DisbursementCheck = z.object({ key: z.string(), ok: z.boolean(), message: z.string() });
export type DisbursementCheck = z.infer<typeof DisbursementCheck>;

export const DisbursementView = z.object({
  id: z.string().nullable(), applicationId: z.string(), applicationStatus: z.string(), status: z.enum(DisbursementStatus),
  approvedAmount: z.number(), disburseAmount: z.number(), termMonths: z.number().int(), interestRate: z.number(),
  repaymentType: z.enum(RepaymentType), firstPaymentDate: z.string().nullable(), disburseDate: z.string().nullable(),
  bankCode: z.string().nullable(), accountNoMasked: z.string().nullable(), holderName: z.string().nullable(),
  accountOwnerType: z.enum(AccountOwnerType).nullable(), nameCheck: z.object({ matched: z.boolean(), registeredName: z.string().nullable(), similarity: z.number() }).nullable(),
  reconciliation: z.object({ ok: z.boolean(), diffs: z.array(z.object({ field: z.string(), decision: z.unknown(), disbursement: z.unknown() })) }).nullable(),
  coreLoanId: z.string().nullable(),
  /** G4 (илгээх хаалга) шалгалтууд; бүгд ok бол "Илгээх" идэвхжинэ */
  checks: z.array(DisbursementCheck), canSubmit: z.boolean(),
  history: z.array(z.object({ at: z.string(), by: z.string().nullable(), action: z.string(), note: z.string().nullable() })),
});
export type DisbursementView = z.infer<typeof DisbursementView>;

export const DecideDisbursementRequest = z.object({ comment: z.string().max(1000).optional() });
export type DecideDisbursementRequest = z.infer<typeof DecideDisbursementRequest>;
