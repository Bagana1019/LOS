import { z } from 'zod';
import { InstallmentStatus, PaymentInvoiceStatus, PaymentProvider } from '../enums';

// Зээлийн эргэн төлөлт цуглуулах (QPay / SocialPay / банкны шилжүүлэг). Мөнгөн дүн: MNT/USD, numeric(18,2) → number.
// 2 оронтой нарийвчлал: 1234.5 ✓, 1234.567 ✗ (мөнгөн дүнг чимээгүй бөөрөнхийлөхгүй)
const hasAtMostTwoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
export const CreatePaymentInvoiceRequest = z.object({
  applicationId: z.string().min(1),
  provider: z.enum(PaymentProvider),
  scheduleRowId: z.string().min(1).optional(), // тодорхой хуваарийн мөр; хоосон бол amount эсвэл "одоо төлөх" дүн
  amount: z.number().positive().refine(hasAtMostTwoDecimals, 'Дүн 2 оронтой нарийвчлалтай байх ёстой').optional(), // хэсэгчилсэн / урьдчилсан төлөлт
  note: z.string().max(200).optional(),
});
export type CreatePaymentInvoiceRequest = z.infer<typeof CreatePaymentInvoiceRequest>;

export const PaymentDeeplink = z.object({ name: z.string(), description: z.string().nullable(), logo: z.string().nullable(), link: z.string() });
export type PaymentDeeplink = z.infer<typeof PaymentDeeplink>;

export const BankTransferInstruction = z.object({ bankCode: z.string(), accountNo: z.string(), accountName: z.string(), reference: z.string() });
export type BankTransferInstruction = z.infer<typeof BankTransferInstruction>;

export const PaymentInvoiceView = z.object({
  id: z.string(),
  applicationId: z.string(),
  provider: z.enum(PaymentProvider),
  status: z.enum(PaymentInvoiceStatus),
  amount: z.number(),
  currency: z.string(),
  scheduleRowId: z.string().nullable(),
  senderInvoiceNo: z.string(), // манай тал дахь дахин давтагдашгүй дугаар (бодит хэрэглээнд гүйлгээний утга)
  expiresAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
  qrText: z.string().nullable(),
  qrImage: z.string().nullable(), // base64 PNG (data URL биш)
  deeplinks: z.array(PaymentDeeplink),
  bankTransfer: BankTransferInstruction.nullable(),
  createdAt: z.string().datetime(),
});
export type PaymentInvoiceView = z.infer<typeof PaymentInvoiceView>;

export const PaymentAllocationView = z.object({
  scheduleRowId: z.string(),
  seq: z.number().int(),
  dueDate: z.string(),
  interestPaid: z.number(),
  principalPaid: z.number(),
  totalPaid: z.number(),
});
export type PaymentAllocationView = z.infer<typeof PaymentAllocationView>;

export const PaymentView = z.object({
  id: z.string(),
  applicationId: z.string(),
  invoiceId: z.string().nullable(),
  provider: z.enum(PaymentProvider),
  providerPaymentId: z.string(),
  amount: z.number(),
  currency: z.string(),
  paidAt: z.string().datetime(),
  unallocatedAmount: z.number(), // хуваарийн нийт төлбөрөөс давсан (урьдчилсан төлөлт) хэсэг
  payerAccountMasked: z.string().nullable(), // NFR-5: дансны дугаар зөвхөн нуугдмал (эхний 2 + сүүлийн 2 тэмдэгт)
  allocations: z.array(PaymentAllocationView),
});
export type PaymentView = z.infer<typeof PaymentView>;

export const InstallmentView = z.object({
  id: z.string(),
  seq: z.number().int(),
  dueDate: z.string(),
  principal: z.number(),
  interest: z.number(),
  total: z.number(),
  paidInterest: z.number(),
  paidPrincipal: z.number(),
  paidTotal: z.number(),
  outstanding: z.number(),
  status: z.enum(InstallmentStatus),
  daysOverdue: z.number().int(),
});
export type InstallmentView = z.infer<typeof InstallmentView>;

export const RepaymentStatusView = z.object({
  applicationId: z.string(),
  currency: z.string(),
  asOf: z.string(), // YYYY-MM-DD (Asia/Ulaanbaatar)
  applicationStatus: z.string(), // ApplicationStatus
  payable: z.boolean(), // ACTIVE | MIGRATED + одоогийн ЭТХ байгаа + үлдэгдэлтэй → төлбөрийн invoice үүсгэж болно
  scheduleGeneratedAt: z.string().datetime().nullable(), // одоогийн (stale биш) ЭТХ-ийн үүсгэсэн цаг; ЭТХ байхгүй бол null (installments хоосон)
  installments: z.array(InstallmentView),
  totals: z.object({ scheduled: z.number(), paid: z.number(), outstanding: z.number(), overdue: z.number() }),
  payNowAmount: z.number(), // хугацаа хэтэрсэн + өнөөдөр төлөх ёстой үлдэгдэл; үгүй бол дараагийн төлбөр
  nextDue: z.object({ scheduleRowId: z.string(), dueDate: z.string(), outstanding: z.number() }).nullable(),
  recentPayments: z.array(PaymentView),
});
export type RepaymentStatusView = z.infer<typeof RepaymentStatusView>;

// enabled=false үед reason: NOT_CONFIGURED (env/тохиргоо дутуу) | NOT_IMPLEMENTED (бодит холболт хараахан хийгдээгүй) | ACCOUNT_MISSING (хүлээн авах данс тохируулаагүй)
export const PaymentProviderInfo = z.object({ provider: z.enum(PaymentProvider), enabled: z.boolean(), mode: z.enum(['mock', 'real']), reason: z.enum(['NOT_CONFIGURED', 'NOT_IMPLEMENTED', 'ACCOUNT_MISSING']).nullable() });
export type PaymentProviderInfo = z.infer<typeof PaymentProviderInfo>;

// FR-12.4: нэр-дугаар тулгалт (банкны API, mock)
export const BankNameCheckRequest = z.object({ bankCode: z.string().min(1), accountNo: z.string().min(4), holderName: z.string().min(1) });
export type BankNameCheckRequest = z.infer<typeof BankNameCheckRequest>;
export const BankNameCheckResponse = z.object({ matched: z.boolean(), registeredName: z.string().nullable(), similarity: z.number().min(0).max(1) });
export type BankNameCheckResponse = z.infer<typeof BankNameCheckResponse>;

// errors: бүртгэхэд алдаа гарсан гүйлгээний тоо (нэг гүйлгээний алдаа бусдыг хаахгүй; FAILED мөр дараагийн тулгалтад дахин оролдогдоно).
export const BankReconcileResponse = z.object({ fetched: z.number().int(), matched: z.number().int(), duplicates: z.number().int(), unmatched: z.number().int(), errors: z.number().int() });
export type BankReconcileResponse = z.infer<typeof BankReconcileResponse>;

// Банкны тулгалтыг гараар ажиллуулах (ADMIN). since хоосон бол сүүлд тулгасан огнооноос (давхцалтай) эхэлнэ.
export const BankReconcileRequest = z.object({ since: z.string().datetime().optional() });
export type BankReconcileRequest = z.infer<typeof BankReconcileRequest>;

// Туршилтын төлөлт (зөвхөн mock горим): өөрсдийн PaymentInvoice.id. amount хоосон бол invoice-ийн дүнгээр; өөр дүн өгвөл дүн зөрөх тохиолдлыг туршина.
export const PaymentSimulateRequest = z.object({ invoiceId: z.string().min(1), amount: z.number().positive().optional() });
export type PaymentSimulateRequest = z.infer<typeof PaymentSimulateRequest>;

// Провайдерын callback-ийн оролт. Агуулгад ИТГЭХГҮЙ — зөвхөн `invoice` (манай senderInvoiceNo)-оор invoice олж checkInvoice-ээр баталгаажуулна.
export const PaymentCallbackParams = z.object({ invoice: z.string().min(1).max(64) });
export type PaymentCallbackParams = z.infer<typeof PaymentCallbackParams>;
