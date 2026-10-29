import { InstallmentStatus, PaymentProvider } from '@los/contracts';
import type {
  BankNameCheckRequest,
  CreatePaymentInvoiceRequest,
  InstallmentView,
  PaymentAllocationView,
  PaymentInvoiceStatus,
  PaymentProviderInfo,
  PaymentView,
  RepaymentStatusView,
} from '@los/contracts';

// Цэвэр логик (React, antd, i18n-ээс хамааралгүй) — vitest-ээр тестлэнэ. Текст шаардлагатай газар `Translate` дамжуулна.
// Серверийн дүрэм (invoice дүн, хязгаар, FIFO хуваарилалт) эцэслэн сервер дээр шийдэгдэнэ; эндхийн шалгалт нь зөвхөн хэрэглэгчид эрт сануулах зорилготой.
// FR-12.4, NFR-2, NFR-5.

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Үйлдэл хориглогдсон / сонголт боломжгүй шалтгаан (i18n түлхүүр + параметр). */
export interface Reason {
  key: string;
  params?: Record<string, string | number>;
}

// ── мөнгө, огноо ────────────────────────────────────────────────────────────────────
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 1250000 → "1,250,000 ₮"; 1250.5 → "1,250.5 ₮"; USD → "1,250.5 USD". Intl-ээс хамаарахгүй тул тестэд тогтвортой. */
export function formatAmount(n: number, currency = 'MNT'): string {
  const abs = Math.abs(n).toFixed(2);
  const [int, dec] = abs.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const negative = n < 0 && Number(abs) > 0;
  return `${negative ? '-' : ''}${grouped}${dec === '00' ? '' : `.${dec}`} ${currency === 'MNT' ? '₮' : currency}`;
}

/** InputNumber-ийн formatter: 1250000.5 → "1,250,000.5". */
export function groupDigits(value: number | string | undefined | null): string {
  if (value === undefined || value === null || value === '') return '';
  const [int, dec] = String(value).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}

/** InputNumber-ийн parser: "1,250,000.5" → "1250000.5" (таслал, тоо биш тэмдэгтийг хасна). */
export const parseDigits = (value: string | undefined | null): string => (value ?? '').replace(/,/g, '').replace(/[^\d.]/g, '');

const UB_TIME_ZONE = 'Asia/Ulaanbaatar';

/** ISO instant → "2026-10-28 17:10" (Asia/Ulaanbaatar; хөтчийн цагийн бүсээс үл хамаарна). */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: UB_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 0.8571 → "86%". */
export const similarityPercent = (similarity: number): string => `${Math.round(Math.min(1, Math.max(0, similarity)) * 100)}%`;

// ── ЭТХ-ийн төлөв ──────────────────────────────────────────────────────────────────
export const INSTALLMENT_STATUSES: readonly InstallmentStatus[] = InstallmentStatus;
export const installmentStatusKey = (s: InstallmentStatus): string => `payment.installment.status.${s}`;
export const INSTALLMENT_COLOR: Record<InstallmentStatus, string> = { UPCOMING: 'default', DUE: 'blue', OVERDUE: 'red', PARTIAL: 'orange', PAID: 'green' };

/** Төлөх ёстой (үлдэгдэлтэй) мөрүүд, хугацааны дарааллаар. */
export function payableRows(installments: readonly InstallmentView[]): InstallmentView[] {
  return installments
    .filter((i) => i.outstanding > 0)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.seq - b.seq));
}

/** Нийт төлөлтийн явц, 0..100 бүхэл хувь. */
export function paidPercent(totals: Pick<RepaymentStatusView['totals'], 'scheduled' | 'paid'>): number {
  if (!(totals.scheduled > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((totals.paid / totals.scheduled) * 100)));
}

/** Application-ийн төлөвийн монгол нэр (`status.*`); үл мэдэгдэх бол анхны утгыг буцаана. */
export function applicationStatusLabel(status: string, tr: Translate): string {
  const key = `status.${status}`;
  const label = tr(key);
  return label === key || label === `!${key}` ? status : label;
}

/** "Төлөх" товч хориглогдох шалтгаан (payable=false үед); боломжтой бол null. */
export function payGate(status: Pick<RepaymentStatusView, 'payable' | 'applicationStatus' | 'scheduleGeneratedAt' | 'installments'>, tr: Translate): Reason | null {
  if (status.payable) return null;
  if (status.applicationStatus !== 'ACTIVE' && status.applicationStatus !== 'MIGRATED') {
    return { key: 'payment.gate.status', params: { status: applicationStatusLabel(status.applicationStatus, tr) } };
  }
  if (!status.scheduleGeneratedAt || status.installments.length === 0) return { key: 'payment.gate.noSchedule' };
  return { key: 'payment.gate.fullyPaid' };
}

// ── төлбөрийн хэлбэр ───────────────────────────────────────────────────────────────
export const PROVIDERS: readonly PaymentProvider[] = PaymentProvider;
export const providerKey = (p: PaymentProvider): string => `payment.provider.${p}`;
export const providerHintKey = (p: PaymentProvider): string => `payment.provider.hint.${p}`;
export const PROVIDER_COLOR: Record<PaymentProvider, string> = { QPAY: 'blue', SOCIALPAY: 'cyan', BANK_TRANSFER: 'purple' };

/** Backend-ийн `reason` + UI-н нэмэлт `CURRENCY` (QPay/SocialPay зөвхөн MNT). */
export type UnavailableReason = NonNullable<PaymentProviderInfo['reason']> | 'CURRENCY';
export const reasonKey = (reason: UnavailableReason): string => `payment.provider.reason.${reason}`;

export interface ProviderOption {
  provider: PaymentProvider;
  enabled: boolean;
  mode: 'mock' | 'real';
  reason: UnavailableReason | null;
}

/**
 * Үргэлж 3 хэлбэрийг тогтмол дарааллаар буцаана. Идэвхгүй нь сонгогдохгүй, шалтгаантай (backend: NOT_CONFIGURED | NOT_IMPLEMENTED | ACCOUNT_MISSING).
 * QPay/SocialPay нь зөвхөн MNT — өөр валютын зээлд сервер 422 CURRENCY_NOT_SUPPORTED өгдөг тул эхнээс нь идэвхгүй болгоно.
 */
export function providerOptions(infos: readonly PaymentProviderInfo[] | undefined, currency: string): ProviderOption[] {
  return PROVIDERS.map((provider): ProviderOption => {
    const info = infos?.find((i) => i.provider === provider);
    if (!info) return { provider, enabled: false, mode: 'real', reason: 'NOT_CONFIGURED' };
    if (!info.enabled) return { provider, enabled: false, mode: info.mode, reason: info.reason ?? 'NOT_CONFIGURED' };
    if (provider !== 'BANK_TRANSFER' && currency !== 'MNT') return { provider, enabled: false, mode: info.mode, reason: 'CURRENCY' };
    return { provider, enabled: true, mode: info.mode, reason: null };
  });
}

export const firstEnabledProvider = (options: readonly ProviderOption[]): PaymentProvider | null => options.find((o) => o.enabled)?.provider ?? null;

/** "Туршилтын төлөлт" товч: зөвхөн mock горим ба production биш (backend мөн ижил шалгана — үгүй бол 404). */
export const canSimulate = (info: Pick<PaymentProviderInfo, 'mode'> | undefined, nodeEnv: string | undefined): boolean => info?.mode === 'mock' && nodeEnv !== 'production';

// ── төлөх дүн ──────────────────────────────────────────────────────────────────────
/** NOW — "одоо төлөх" дүн (сервер payNowAmount-аар), ROW — сонгосон мөрийн үлдэгдэл, CUSTOM — хэрэглэгчийн оруулсан дүн. */
export type AmountMode = 'NOW' | 'ROW' | 'CUSTOM';
export const AMOUNT_MODES: readonly AmountMode[] = ['NOW', 'ROW', 'CUSTOM'];
export const amountModeKey = (m: AmountMode): string => `payment.pay.mode.${m}`;

export interface PayFormValues {
  provider: PaymentProvider | null;
  mode: AmountMode;
  rowId: string | null;
  amount: number | null;
  note: string;
}

type StatusForPay = Pick<RepaymentStatusView, 'installments' | 'payNowAmount' | 'totals' | 'nextDue' | 'currency'>;

/** Хуваарийн мөр сонгоогүй үед өгөх анхдагч мөр: хүссэн мөр (төлөх боломжтой бол) → дараагийн төлөлт → хамгийн эхний төлөх мөр. */
export function defaultRowId(status: Pick<RepaymentStatusView, 'installments' | 'nextDue'>, preferred?: string | null): string | null {
  const rows = payableRows(status.installments);
  if (preferred && rows.some((r) => r.id === preferred)) return preferred;
  if (status.nextDue && rows.some((r) => r.id === status.nextDue?.scheduleRowId)) return status.nextDue.scheduleRowId;
  return rows[0]?.id ?? null;
}

/** Анхны утга. `provider` нь null (= "эхний идэвхтэй хэлбэр", `resolveProvider`-оор тодорхойлогдоно); мөр заасан бол ROW горим. */
export function initialPayForm(status: Pick<RepaymentStatusView, 'installments' | 'nextDue'>, preferredRowId?: string | null): PayFormValues {
  const rowId = defaultRowId(status, preferredRowId);
  const wantsRow = !!preferredRowId && rowId === preferredRowId;
  return { provider: null, mode: wantsRow ? 'ROW' : 'NOW', rowId, amount: null, note: '' };
}

/** Сонгосон хэлбэр идэвхтэй бол түүнийг, үгүй (сонгоогүй/идэвхгүй болсон) бол эхний идэвхтэй хэлбэрийг. */
export function resolveProvider(selected: PaymentProvider | null, options: readonly ProviderOption[]): PaymentProvider | null {
  return selected && options.find((o) => o.provider === selected)?.enabled ? selected : firstEnabledProvider(options);
}

export interface ModeOption { mode: AmountMode; enabled: boolean }

export function modeOptions(status: Pick<StatusForPay, 'installments' | 'payNowAmount' | 'totals'>): ModeOption[] {
  return [
    { mode: 'NOW', enabled: status.payNowAmount > 0 },
    { mode: 'ROW', enabled: payableRows(status.installments).length > 0 },
    { mode: 'CUSTOM', enabled: status.totals.outstanding > 0 },
  ];
}

/** Тухайн горимд төлж болох дээд дүн: ROW — мөрийн үлдэгдэл, бусад — нийт үлдэгдэл (сервертэй ижил). */
export function maxPayable(status: Pick<StatusForPay, 'installments' | 'totals'>, mode: AmountMode, rowId: string | null): number {
  if (mode === 'ROW') return status.installments.find((i) => i.id === rowId)?.outstanding ?? 0;
  return status.totals.outstanding;
}

/** Хэрэглэгчид "төлөх дүн" гэж харуулах утга; тодорхойгүй (CUSTOM хоосон гэх мэт) бол null. */
export function previewAmount(status: StatusForPay, v: Pick<PayFormValues, 'mode' | 'rowId' | 'amount'>): number | null {
  switch (v.mode) {
    case 'NOW':
      return status.payNowAmount > 0 ? status.payNowAmount : null;
    case 'ROW': {
      const outstanding = status.installments.find((i) => i.id === v.rowId)?.outstanding ?? 0;
      return outstanding > 0 ? outstanding : null;
    }
    case 'CUSTOM':
      return v.amount != null && Number.isFinite(v.amount) && v.amount > 0 ? round2(v.amount) : null;
  }
}

const hasAtMostTwoDecimals = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** Өөр дүн: эерэг, ≤ 2 орон, ≤ дээд хэмжээ. Доод хязгаар (payment.min_amount) setting-д байдаг тул сервер шалгаж 422 AMOUNT_OUT_OF_RANGE буцаана. */
export function validateCustomAmount(value: number | null | undefined, max: number, currency: string): Reason | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return { key: 'payment.validation.amountRequired' };
  if (value <= 0) return { key: 'payment.validation.amountPositive' };
  if (!hasAtMostTwoDecimals(value)) return { key: 'payment.validation.amountDecimals' };
  if (round2(value) > max) return { key: 'payment.validation.amountMax', params: { max: formatAmount(max, currency) } };
  return null;
}

/** "Үргэлжлүүлэх" товчийг идэвхгүй болгох шалтгаан; бүрэн бол null. */
export function validatePayForm(status: StatusForPay, options: readonly ProviderOption[], v: PayFormValues): Reason | null {
  if (!v.provider || !options.find((o) => o.provider === v.provider)?.enabled) return { key: 'payment.validation.providerRequired' };
  const mode = modeOptions(status).find((m) => m.mode === v.mode);
  if (!mode?.enabled) return { key: 'payment.validation.modeUnavailable' };
  if (v.mode === 'ROW' && !payableRows(status.installments).some((r) => r.id === v.rowId)) return { key: 'payment.validation.rowRequired' };
  if (v.mode === 'CUSTOM') return validateCustomAmount(v.amount, maxPayable(status, 'CUSTOM', null), status.currency);
  return null;
}

/**
 * POST /payments/invoices-ийн body. NOW — зөвхөн provider (сервер payNowAmount-аар), ROW — scheduleRowId (мөрийн үлдэгдлээр),
 * CUSTOM — amount (мөр заахгүй). Талбар дутуу бол null. Тайлбар 200 тэмдэгтээр хязгаарлагдана.
 */
export function buildInvoiceRequest(applicationId: string, v: PayFormValues): CreatePaymentInvoiceRequest | null {
  if (!v.provider) return null;
  const req: CreatePaymentInvoiceRequest = { applicationId, provider: v.provider };
  if (v.mode === 'ROW') {
    if (!v.rowId) return null;
    req.scheduleRowId = v.rowId;
  } else if (v.mode === 'CUSTOM') {
    if (v.amount == null || !Number.isFinite(v.amount) || v.amount <= 0) return null;
    req.amount = round2(v.amount);
  }
  const note = v.note.trim().slice(0, 200);
  if (note) req.note = note;
  return req;
}

// ── invoice ────────────────────────────────────────────────────────────────────────
export const POLL_INTERVAL_MS = 3000;
/** PENDING үед 3 секунд тутам GET invoice (callback алдагдсан үед сервер өөрөө провайдераас шалгана); эцсийн төлөвт зогсоно. */
export const pollInterval = (status: PaymentInvoiceStatus | undefined): number | false => (status === 'PENDING' ? POLL_INTERVAL_MS : false);

/** Хугацаа дуусахад үлдсэн секунд (≥ 0). Буруу огноо бол 0. */
export function remainingSeconds(expiresAtIso: string, nowMs: number): number {
  const exp = new Date(expiresAtIso).getTime();
  if (Number.isNaN(exp)) return 0;
  return Math.max(0, Math.ceil((exp - nowMs) / 1000));
}

/** 305 → "05:05"; 3725 → "1:02:05". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** DTO-д qrImage нь base64 PNG (data URL биш). Аль хэдийн data URL бол хэвээр. */
export function qrImageSrc(qrImage: string | null | undefined): string | null {
  if (!qrImage) return null;
  return qrImage.startsWith('data:') ? qrImage : `data:image/png;base64,${qrImage}`;
}

const UNSAFE_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob']);
/** Deeplink нь банкны апп-ын custom scheme (`khanbank://…`) эсвэл https байж болно; скрипт ажиллуулах scheme-ийг хаана. */
export function isSafeDeeplink(link: string): boolean {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(link);
  return !!m && !UNSAFE_SCHEMES.has(m[1].toLowerCase());
}

// ── төлбөрийн түүх ─────────────────────────────────────────────────────────────────
/** Мөрүүдэд хуваарилагдсан нийт дүн (= төлбөр − хуваарилаагүй). Мөнгөн дүнг 2 оронд бөөрөнхийлнө. */
export const allocatedAmount = (p: Pick<PaymentView, 'amount' | 'unallocatedAmount'>): number => round2(p.amount - p.unallocatedAmount);

export function sortAllocations(allocations: readonly PaymentAllocationView[]): PaymentAllocationView[] {
  return [...allocations].sort((a, b) => a.seq - b.seq);
}

// ── алдаа ──────────────────────────────────────────────────────────────────────────
/** Backend-ийн алдааны `code` → i18n түлхүүр (payment.error.*). */
export const ERROR_KEYS = {
  LOAN_NOT_PAYABLE: 'payment.error.LOAN_NOT_PAYABLE',
  SCHEDULE_NOT_FOUND: 'payment.error.SCHEDULE_NOT_FOUND',
  SCHEDULE_ROW_NOT_FOUND: 'payment.error.SCHEDULE_ROW_NOT_FOUND',
  INSTALLMENT_PAID: 'payment.error.INSTALLMENT_PAID',
  LOAN_FULLY_PAID: 'payment.error.LOAN_FULLY_PAID',
  AMOUNT_OUT_OF_RANGE: 'payment.error.AMOUNT_OUT_OF_RANGE',
  CURRENCY_NOT_SUPPORTED: 'payment.error.CURRENCY_NOT_SUPPORTED',
  PROVIDER_NOT_CONFIGURED: 'payment.error.PROVIDER_NOT_CONFIGURED',
  PROVIDER_NOT_IMPLEMENTED: 'payment.error.PROVIDER_NOT_IMPLEMENTED',
  PROVIDER_UNAVAILABLE: 'payment.error.PROVIDER_UNAVAILABLE',
  PROVIDER_REJECTED: 'payment.error.PROVIDER_REJECTED',
  INVOICE_ALREADY_PAID: 'payment.error.INVOICE_ALREADY_PAID',
  INVOICE_NOT_PENDING: 'payment.error.INVOICE_NOT_PENDING',
  INVOICE_NOT_FOUND: 'payment.error.INVOICE_NOT_FOUND',
  INVOICE_NUMBER_CONFLICT: 'payment.error.INVOICE_NUMBER_CONFLICT',
  APPLICATION_NOT_FOUND: 'payment.error.APPLICATION_NOT_FOUND',
  VALIDATION_FAILED: 'payment.error.VALIDATION_FAILED',
  UNAUTHENTICATED: 'payment.error.UNAUTHENTICATED',
  FORBIDDEN: 'payment.error.FORBIDDEN',
  NOT_FOUND: 'payment.error.NOT_FOUND',
} as const;

/** Эдгээр код дээр серверийн мессеж динамик өгөгдөлтэй (жишээ нь зөвшөөрөгдөх дүнгийн муж) тул түүнийг түрүүлж харуулна. */
const SERVER_MESSAGE_FIRST = new Set<string>(['AMOUNT_OUT_OF_RANGE']);

export interface DescribedError {
  code: string | null;
  message: string;
  /** VALIDATION_FAILED үед талбар бүрийн тайлбар. */
  issues: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function describeError(error: unknown, tr: Translate): DescribedError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const status = typeof e.status === 'number' ? e.status : null;
  const serverMessage = str(e.message);
  const fallback = (key: string): DescribedError => ({ code, message: tr(key), issues: [] });

  if (code && Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)) {
    if (SERVER_MESSAGE_FIRST.has(code) && serverMessage) return { code, message: serverMessage, issues: [] };
    const issues = code === 'VALIDATION_FAILED' && Array.isArray(e.issues)
      ? e.issues.flatMap((i: unknown) => {
          const issue = i as { path?: unknown; message?: unknown } | null;
          const text = str(issue?.message);
          if (!text) return [];
          const path = str(issue?.path);
          return [path ? `${path}: ${text}` : text];
        })
      : [];
    return { code, message: tr(ERROR_KEYS[code as keyof typeof ERROR_KEYS]), issues };
  }
  if (status === 401) return fallback(ERROR_KEYS.UNAUTHENTICATED);
  if (status === 403) return fallback(ERROR_KEYS.FORBIDDEN);
  if (status === 404) return fallback(ERROR_KEYS.NOT_FOUND);
  if (status !== null && status >= 500) return fallback('payment.error.SERVER');
  if (error instanceof TypeError) return fallback('payment.error.NETWORK'); // fetch холбогдож чадаагүй
  if (status !== null && serverMessage) return { code, message: serverMessage, issues: [] };
  return fallback('payment.error.UNKNOWN');
}

/** Invoice аль хэдийн төлөгдсөн — цуцлах оролдлого 409 өгсөн бол invoice-ийг дахин татаж PAID харуулна. */
export const isAlreadyPaidError = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'INVOICE_ALREADY_PAID';

/** Мутацийн дараа 404/409 бол сервер дээрх төлөв манайхаас зөрсөн тул дахин татна. */
export const isStaleStateError = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 409;
};

// ── банкны шилжүүлэг, тулгалт, нэр шалгалт ──────────────────────────────────────────
/** FR-12.4: нэр-дугаар тулгалтын form → хүсэлт. Буруу бол null (DTO: bankCode ≥1, accountNo ≥4, holderName ≥1). */
export function buildNameCheckRequest(v: { bankCode?: string; accountNo?: string; holderName?: string }): BankNameCheckRequest | null {
  const bankCode = (v.bankCode ?? '').trim().toUpperCase();
  const accountNo = (v.accountNo ?? '').replace(/\s+/g, '');
  const holderName = (v.holderName ?? '').trim();
  if (!bankCode || accountNo.length < 4 || !holderName) return null;
  return { bankCode, accountNo, holderName };
}

/** Банкны тулгалтын үр дүн, ойлгомжтой нэг мөр. */
export function describeReconcile(r: { fetched: number; matched: number; duplicates: number; unmatched: number; errors?: number }, tr: Translate): string {
  const base = tr('payment.tools.reconcile.result', { fetched: r.fetched, matched: r.matched, duplicates: r.duplicates, unmatched: r.unmatched });
  return r.errors ? `${base} · ${tr('payment.tools.reconcile.errors', { errors: r.errors })}` : base;
}
