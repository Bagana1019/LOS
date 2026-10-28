// docs/03-data-model.md § Enum — энд л тодорхойлно, бусад газар импортолно
export const ApplicationStatus = ['DRAFT','SUBMITTED','IN_APPROVAL','APPROVED','RETURNED','DISBURSING','ACTIVE','CLOSED','MIGRATED'] as const;
export type ApplicationStatus = typeof ApplicationStatus[number];
export const StepKey = ['client','inquiry','income','loan','collateral','installment','score','document','decision','contract','official_documents','disburse'] as const;
export type StepKey = typeof StepKey[number];
export const StepStatus = ['LOCKED','PENDING','COMPLETED','STALE'] as const;
export const BorrowerRole = ['PRIMARY','CO_BORROWER','GUARANTOR','PLEDGOR'] as const;
export const CalcMethod = ['A_SALARY','B_BUSINESS','C_COMBINED'] as const;
export const RepaymentType = ['ANNUITY','EQUAL_PRINCIPAL','QUARTERLY','BULLET'] as const;
export const AssetType = ['VEHICLE','APARTMENT','HOUSE','LAND','LIVESTOCK','INVENTORY','EQUIPMENT','OTHER'] as const;
export const ValuationSource = ['INTERNAL','EXTERNAL_LICENSED'] as const;
export const InquirySource = ['CIB','FICO','DTI','LIVESTOCK','XYP_PROPERTY','XYP_VEHICLE','XYP_PENSION','XYP_LEGAL','XYP_CRIMINAL','XYP_COURT_DEBT','BLACKLIST'] as const;
export const BsaStatus = ['DRAFT','ANALYZED'] as const;
export const ImportStatus = ['PENDING','PROCESSING','COMPLETED','FAILED'] as const;
export const SuspicionFlag = ['OWN_ACCOUNT','CIRCULAR','INTER_ACCOUNT_FRAUD','QUICK_CASH','SPLIT_WITHDRAWAL','COLLUSION','STRUCTURING','GAMBLING'] as const;
export const UserRole = ['OFFICER','BRANCH_MANAGER','APPROVER','ADMIN'] as const;
export type UserRole = typeof UserRole[number];
