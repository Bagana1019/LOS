import type {
  BankNameCheckRequest,
  BankNameCheckResponse,
  BankReconcileRequest,
  BankReconcileResponse,
  CreatePaymentInvoiceRequest,
  PaymentInvoiceView,
  PaymentProviderInfo,
  PaymentSimulateRequest,
  PaymentView,
  RepaymentStatusView,
} from '@los/contracts';
import { apiFetch } from '../../lib/api';

// Gateway-н замаар origination руу: `/payments/…`, `/applications/:id/…` (global prefix `api` нь API суурь URL-д орсон).
const enc = encodeURIComponent;

/** Нэвтэрсэн бүх хэрэглэгч. enabled=false үед reason: NOT_CONFIGURED | NOT_IMPLEMENTED | ACCOUNT_MISSING. */
export const fetchProviders = (): Promise<PaymentProviderInfo[]> => apiFetch<PaymentProviderInfo[]>('/payments/providers');

export const fetchRepaymentStatus = (applicationId: string): Promise<RepaymentStatusView> =>
  apiFetch<RepaymentStatusView>(`/applications/${enc(applicationId)}/repayment-status`);

/** Шинэ нь эхэнд, allocations-тай. */
export const fetchPayments = (applicationId: string): Promise<PaymentView[]> => apiFetch<PaymentView[]>(`/applications/${enc(applicationId)}/payments`);

/** 201 — шинэ invoice; 200 — адил хүсэлтийн байгаа PENDING invoice (idempotent). Хоёулаа ижил DTO. */
export const createInvoice = (body: CreatePaymentInvoiceRequest): Promise<PaymentInvoiceView> =>
  apiFetch<PaymentInvoiceView>('/payments/invoices', { method: 'POST', json: body });

/** PENDING бол сервер провайдераас шалгаж шинэчилнэ; хугацаа дууссан бол EXPIRED. */
export const fetchInvoice = (invoiceId: string): Promise<PaymentInvoiceView> => apiFetch<PaymentInvoiceView>(`/payments/invoices/${enc(invoiceId)}`);

/** PENDING → CANCELLED. Төлөгдсөн бол 409 INVOICE_ALREADY_PAID. */
export const cancelInvoice = (invoiceId: string): Promise<PaymentInvoiceView> =>
  apiFetch<PaymentInvoiceView>(`/payments/invoices/${enc(invoiceId)}/cancel`, { method: 'POST' });

/** ADMIN, зөвхөн mock горим ба NODE_ENV≠production (үгүй бол 404). */
export const simulatePayment = (body: PaymentSimulateRequest): Promise<PaymentInvoiceView> =>
  apiFetch<PaymentInvoiceView>('/payments/dev/simulate', { method: 'POST', json: body });

/** ADMIN. `since` хоосон бол сервер сүүлд тулгасан огнооноос эхэлнэ. */
export const reconcileBankTransfers = (body: BankReconcileRequest = {}): Promise<BankReconcileResponse> =>
  apiFetch<BankReconcileResponse>('/payments/bank-transfers/reconcile', { method: 'POST', json: body });

/** OFFICER, ADMIN. FR-12.4. */
export const checkBankAccountName = (body: BankNameCheckRequest): Promise<BankNameCheckResponse> =>
  apiFetch<BankNameCheckResponse>('/payments/bank-accounts/name-check', { method: 'POST', json: body });
