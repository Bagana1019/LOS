// docs/03-data-model.md § Enum — энд л тодорхойлно, бусад газар импортолно
export const ApplicationStatus = ['DRAFT','SUBMITTED','IN_APPROVAL','APPROVED','RETURNED','DISBURSING','ACTIVE','CLOSED','MIGRATED'] as const;
export type ApplicationStatus = typeof ApplicationStatus[number];
export const StepKey = ['client','inquiry','income','loan','collateral','installment','score','document','decision','contract','official_documents','disburse'] as const;
export type StepKey = typeof StepKey[number];
export const StepStatus = ['LOCKED','PENDING','COMPLETED','STALE'] as const;
export type StepStatus = typeof StepStatus[number];
export const BorrowerRole = ['PRIMARY','CO_BORROWER','GUARANTOR','PLEDGOR'] as const;
export type BorrowerRole = typeof BorrowerRole[number];
export const CustomerType = ['INDIVIDUAL','LEGAL_ENTITY'] as const;
export type CustomerType = typeof CustomerType[number];
export const ApprovalDecision = ['APPROVE','RETURN'] as const;
export type ApprovalDecision = typeof ApprovalDecision[number];
export const CalcMethod = ['A_SALARY','B_BUSINESS','C_COMBINED'] as const;
export type CalcMethod = typeof CalcMethod[number];
export const RepaymentType = ['ANNUITY','EQUAL_PRINCIPAL','QUARTERLY','BULLET'] as const;
export type RepaymentType = typeof RepaymentType[number];
export const CollateralKind = ['MOVABLE','IMMOVABLE'] as const;
export type CollateralKind = typeof CollateralKind[number];
export const AssetType = ['VEHICLE','APARTMENT','HOUSE','LAND','LIVESTOCK','INVENTORY','EQUIPMENT','OTHER'] as const;
export type AssetType = typeof AssetType[number];
export const ValuationSource = ['INTERNAL','EXTERNAL_LICENSED'] as const;
export type ValuationSource = typeof ValuationSource[number];
export const InquirySource = ['CIB','FICO','DTI','LIVESTOCK','XYP_PROPERTY','XYP_VEHICLE','XYP_PENSION','XYP_LEGAL','XYP_CRIMINAL','XYP_COURT_DEBT','BLACKLIST'] as const;
export type InquirySource = typeof InquirySource[number];
export const BsaStatus = ['DRAFT','ANALYZED'] as const;
export type BsaStatus = typeof BsaStatus[number];
export const ImportStatus = ['PENDING','PROCESSING','COMPLETED','FAILED'] as const;
export type ImportStatus = typeof ImportStatus[number];
export const TxnDirection = ['INCOME','EXPENSE'] as const;
export type TxnDirection = typeof TxnDirection[number];
export const SuspicionFlag = ['OWN_ACCOUNT','CIRCULAR','INTER_ACCOUNT_FRAUD','QUICK_CASH','SPLIT_WITHDRAWAL','COLLUSION','STRUCTURING','GAMBLING'] as const;
export type SuspicionFlag = typeof SuspicionFlag[number];
export const ReviewStatus = ['PENDING','RESOLVED'] as const;
export type ReviewStatus = typeof ReviewStatus[number];
export const ReviewAction = ['APPROVE','RECLASSIFY','EXCLUDE'] as const;
export type ReviewAction = typeof ReviewAction[number];
export const NotificationType = ['APPROVAL_REQUESTED','RETURNED','APPROVED','DISBURSEMENT_APPROVED','SLA_BREACH','MENTION','PAYMENT_DUE','PAYMENT_OVERDUE','PAYMENT_RECEIVED'] as const;
export type NotificationType = typeof NotificationType[number];
export const RiskBand = ['GREEN','YELLOW','RED'] as const;
export type RiskBand = typeof RiskBand[number];
export const UserRole = ['OFFICER','BRANCH_MANAGER','APPROVER','ADMIN'] as const;
export type UserRole = typeof UserRole[number];

// ── docs/03-д баганы тайлбар хэлбэрээр байгаа (`A | B | C`) утгууд — Prisma-д String, энд цорын ганц эх сурвалж ──
export const ApplicationSource = ['WEB','SYSTEM','API'] as const;
export type ApplicationSource = typeof ApplicationSource[number];
export const ApprovalRequestStatus = ['PENDING','APPROVED','RETURNED'] as const;
export type ApprovalRequestStatus = typeof ApprovalRequestStatus[number];
export const QuorumType = ['MAJORITY'] as const;
export type QuorumType = typeof QuorumType[number];
export const SeqScope = ['DAY','BRANCH','GLOBAL'] as const;
export type SeqScope = typeof SeqScope[number];
export const ContractTemplateType = ['LOAN_CONTRACT','SCHEDULE','OFFICIAL_LETTER'] as const;
export type ContractTemplateType = typeof ContractTemplateType[number];
export const EncumbranceStatus = ['CLEAR','ENCUMBERED','DISPUTED'] as const;
export type EncumbranceStatus = typeof EncumbranceStatus[number];
export const CollateralSource = ['XYP','MANUAL'] as const;
export type CollateralSource = typeof CollateralSource[number];
export const DisbursementStatus = ['DRAFT','SUBMITTED','APPROVED','SENT_TO_CORE','FAILED'] as const;
export type DisbursementStatus = typeof DisbursementStatus[number];
export const AccountOwnerType = ['SELF','THIRD_PARTY'] as const;
export type AccountOwnerType = typeof AccountOwnerType[number];
export const BankAccountSource = ['MANUAL','STATEMENT'] as const;
export type BankAccountSource = typeof BankAccountSource[number];
export const IncomeSalarySource = ['NDSH','MANUAL'] as const;
export type IncomeSalarySource = typeof IncomeSalarySource[number];
export const ManualIncomeType = ['RENT','PENSION','OTHER'] as const;
export type ManualIncomeType = typeof ManualIncomeType[number];
export const BsaChannel = ['QPAY','POS','ATM','TRANSFER','OTHER'] as const;
export type BsaChannel = typeof BsaChannel[number];
export const BsaDtiRole = ['INCOME','DEBT_SERVICE','HOUSEHOLD','BUSINESS_EXPENSE','EXCLUDE','INFO'] as const;
export type BsaDtiRole = typeof BsaDtiRole[number];
export const BsaRuleMatchType = ['KEYWORD','COUNTERPARTY','REGEX'] as const;
export type BsaRuleMatchType = typeof BsaRuleMatchType[number];
export const BsaRuleSource = ['ADMIN','FEEDBACK'] as const;
export type BsaRuleSource = typeof BsaRuleSource[number];
export const CustomerContactRelation = ['SPOUSE','PARENT','CHILD','SIBLING','RELATIVE','FRIEND','COLLEAGUE','OTHER'] as const;
export type CustomerContactRelation = typeof CustomerContactRelation[number];
export const DocumentRelatedEntity = ['BORROWER','COLLATERAL','APPLICATION'] as const;
export type DocumentRelatedEntity = typeof DocumentRelatedEntity[number];

// ── Хамтран зээлдэгч / батлан даагч, төлбөр, мэдэгдэл, тайлан (docs/05-borrower-payment-notification-report.md) ──
export const BorrowerRelation = ['SPOUSE','PARENT','CHILD','SIBLING','RELATIVE','BUSINESS_PARTNER','COLLEAGUE','FRIEND','OTHER'] as const;
export type BorrowerRelation = typeof BorrowerRelation[number];
export const GuaranteeType = ['JOINT_AND_SEVERAL','LIMITED'] as const;
export type GuaranteeType = typeof GuaranteeType[number];
export const BorrowerWarningCode = ['BLACKLISTED','PEP','RELATED_PARTY','CONSENT_MISSING','GUARANTEE_BELOW_LOAN','LIABILITY_SHARE_INCOMPLETE'] as const;
export type BorrowerWarningCode = typeof BorrowerWarningCode[number];

export const PaymentProvider = ['QPAY','SOCIALPAY','BANK_TRANSFER'] as const;
export type PaymentProvider = typeof PaymentProvider[number];
export const PaymentInvoiceStatus = ['PENDING','PAID','EXPIRED','CANCELLED'] as const;
export type PaymentInvoiceStatus = typeof PaymentInvoiceStatus[number];
export const InstallmentStatus = ['UPCOMING','DUE','OVERDUE','PARTIAL','PAID'] as const;
export type InstallmentStatus = typeof InstallmentStatus[number];

export const NotificationChannel = ['IN_APP','SMS','EMAIL','PUSH'] as const;
export type NotificationChannel = typeof NotificationChannel[number];
export const DeliveryStatus = ['QUEUED','SENT','FAILED','SKIPPED'] as const;
export type DeliveryStatus = typeof DeliveryStatus[number];
export const RecipientType = ['USER','CUSTOMER'] as const;
export type RecipientType = typeof RecipientType[number];
export const PushPlatform = ['ANDROID','IOS','WEB'] as const;
export type PushPlatform = typeof PushPlatform[number];

export const ReportKey = ['upcoming-repayments','overdue-loans','outstanding-balance','closed-loans','disbursed-loans','interest-payments','collateral-assets','pipeline-progress','deposit-balances'] as const;
export type ReportKey = typeof ReportKey[number];
export const AgingBucket = ['CURRENT','DPD_1_30','DPD_31_60','DPD_61_90','DPD_90_PLUS'] as const;
export type AgingBucket = typeof AgingBucket[number];

export const IntegrationMode = ['mock','real'] as const;
export type IntegrationMode = typeof IntegrationMode[number];
// ── Module 1 (FR-2.3): docs/03-д enum-ийн жагсаалт өгөөгүй баганууд — утгыг DECISIONS.md-д бүртгэсэн ──
export const Gender = ['MALE','FEMALE'] as const;
export type Gender = typeof Gender[number];
export const MaritalStatus = ['SINGLE','MARRIED','DIVORCED','WIDOWED'] as const;
export type MaritalStatus = typeof MaritalStatus[number];
// FR-11.4 Цахим гарын үсэг (цаасгүй гэрээ). Provider adapter: apps/dms/src/integrations/{tridum,monpass}
export const ESignProvider = ['TRIDUM','MONPASS'] as const;
export type ESignProvider = typeof ESignProvider[number];
// PENDING: линк илгээсэн, зээлдэгч provider сонгоогүй · IN_PROGRESS: provider-т session нээгдсэн, апп дээр баталгаажуулахыг хүлээж буй
// FINALIZING: гарын үсэг ирсэн, QR/штамп зурж DMS-д хадгалж буй (түр төлөв) · SIGNED/DECLINED/EXPIRED/FAILED/CANCELLED: төгсгөлийн төлөв
export const SigningStatus = ['PENDING','IN_PROGRESS','FINALIZING','SIGNED','DECLINED','EXPIRED','FAILED','CANCELLED'] as const;
export type SigningStatus = typeof SigningStatus[number];
export const SigningFailureReason = ['DECLINED','EXPIRED','IDENTITY_MISMATCH','INTEGRITY_ERROR','PROVIDER_ERROR','CANCELLED'] as const;
export type SigningFailureReason = typeof SigningFailureReason[number];
