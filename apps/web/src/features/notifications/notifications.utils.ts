import { DeliveryStatus, NotificationChannel, NotificationType, TEMPLATE_PLACEHOLDERS } from '@los/contracts';
import type {
  DeliveryListQuery,
  DeliveryView,
  NotificationPreferenceRequest,
  NotificationPreferenceView,
  NotificationView,
  PreviewTemplateRequest,
  RunRemindersResponse,
  SendTestRequest,
  TemplatePlaceholder,
  TemplateView,
  UpsertTemplateRequest,
} from '@los/contracts';
import type { NotificationBellItem } from '@los/ui';

// Цэвэр логик (React, antd, i18n-ээс хамааралгүй) — vitest-ээр тестлэнэ.
// Текст шаардлагатай газар `Translate` дамжуулна (components нь `t`-ийг өгнө).
// FR-13.2: мэдэгдэл (хонх, SMS, имэйл, push), төлөлт сануулах; NFR-5 (хувийн мэдээлэл нуугдмал).

export type Translate = (key: string, params?: Record<string, string | number>) => string;

// ── төрөл, суваг, төлөвийн түлхүүрүүд ───────────────────────────────────────────────
export const NOTIFICATION_TYPES: readonly NotificationType[] = NotificationType;
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = NotificationChannel;
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = DeliveryStatus;
/** Зээлдэгчид илгээж болох суваг (IN_APP нь зөвхөн ажилтны хонх). */
export const CUSTOMER_CHANNELS = ['SMS', 'EMAIL', 'PUSH'] as const satisfies readonly NotificationChannel[];
export type CustomerChannel = (typeof CUSTOMER_CHANNELS)[number];
/** Зээлдэгчид чиглэсэн мэдэгдлийн төрлүүд — backend-ийн кодонд суулгасан SMS/EMAIL/PUSH загвартай төрлүүд. */
export const CUSTOMER_TYPES = ['APPROVED', 'DISBURSEMENT_APPROVED', 'PAYMENT_DUE', 'PAYMENT_OVERDUE', 'PAYMENT_RECEIVED'] as const satisfies readonly NotificationType[];

export const typeKey = (type: NotificationType): string => `notification.type.${type}`;
export const channelKey = (channel: NotificationChannel): string => `notification.channel.${channel}`;
export const statusKey = (status: DeliveryStatus): string => `notification.status.${status}`;
export const recipientTypeKey = (type: 'USER' | 'CUSTOMER'): string => `notification.recipientType.${type}`;
export const placeholderKey = (name: TemplatePlaceholder): string => `notification.placeholder.${name}`;
export const sourceKey = (source: TemplateSource): string => `notification.templates.source.${source}`;

export const STATUS_COLOR: Record<DeliveryStatus, string> = { QUEUED: 'processing', SENT: 'success', FAILED: 'error', SKIPPED: 'default' };
export const CHANNEL_COLOR: Record<NotificationChannel, string> = { IN_APP: 'blue', SMS: 'cyan', EMAIL: 'geekblue', PUSH: 'purple' };

// ── огноо, хугацаа ────────────────────────────────────────────────────────────────────
const UB_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Ulaanbaatar = UTC+8 (зуны цагийн шилжилтгүй)

/** ISO instant → "2026-10-28 17:05" (Улаанбаатарын цагаар; Intl-ээс хамаарахгүй тул тестэд тогтвортой). */
export function formatDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + UB_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** "Дөнгөж сая" · "5 минутын өмнө" · "3 цагийн өмнө" · "2 өдрийн өмнө"; 7 хоногоос хуучин бол огноо. */
export function relativeTime(iso: string, nowMs: number, tr: Translate): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = nowMs - ms;
  if (diff < 60_000) return tr('notification.time.justNow'); // цагийн зөрүүгээс болж ирээдүйн огноо ч энд орно
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return tr('notification.time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr('notification.time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return tr('notification.time.daysAgo', { n: days });
  return formatDateTime(iso);
}

/** Strict YYYY-MM-DD (бодит хуанлийн өдөр). */
export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// ── текст ───────────────────────────────────────────────────────────────────────────
/** Олон мөр, илүү зайг нэг зай болгож, `max`-аас урт бол "…" залгана. */
export function truncate(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

export const shortId = (id: string, length = 8): string => (id.length <= length ? id : id.slice(0, length));

// ── ажилтны хонх (in-app) ────────────────────────────────────────────────────────────
/** Хүсэлттэй холбоотой мэдэгдэл дарахад очих хуудас (brief: шийдвэрийн алхам). Хүсэлтгүй бол null. */
export function notificationHref(n: Pick<NotificationView, 'applicationId'>): string | null {
  return n.applicationId ? `/los/loan-application/${encodeURIComponent(n.applicationId)}/decision` : null;
}

/** Хонхны жагсаалтын мөр. Гарчиг хоосон бол (загвар байхгүй) төрлийн нэрийг ашиглана. */
export function toBellItem(n: NotificationView, nowMs: number, tr: Translate): NotificationBellItem {
  return { id: n.id, title: n.title.trim() || tr(typeKey(n.type)), body: n.body, timeLabel: relativeTime(n.createdAt, nowMs, tr), read: n.readAt !== null };
}

export interface NotificationListParams { unreadOnly?: boolean; page?: number; pageSize?: number }

/** Query string-д зориулсан утгууд. `unreadOnly=false` нь анхдагч тул илгээхгүй. */
export function buildListQuery(p: NotificationListParams): Record<string, string | number | boolean | undefined> {
  return { unreadOnly: p.unreadOnly ? true : undefined, page: p.page, pageSize: p.pageSize };
}

/** Мэдэгдэл устсан/уншигдсаны дараа сүүлийн хуудас хоосорвол ойролцоох хуудас руу буцаана. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return Math.min(Math.max(1, page), last);
}

/** 401/403 (нэвтрээгүй, эрхгүй) үед хонх дахин асуухаас зогсоно — 30 секунд тутам алдаа гаргах утгагүй. */
export function shouldPoll(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return !(status === 401 || status === 403);
}

/** 4xx (эрх, олдсонгүй, дүрэм) дахин оролдсоноор засагдахгүй. Сүлжээ/серверийн алдааг л нэг удаа дахин оролдоно. */
export function retryTransient(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
}

// ── загвар ──────────────────────────────────────────────────────────────────────────
export const TEMPLATE_BODY_MAX = 2000;
export const TEMPLATE_SUBJECT_MAX = 200;
/** SMS-ийн зорилтот хязгаар: кирилл (UCS-2) 2 сегмент ≈ 134 тэмдэгт. */
export const SMS_TARGET_LENGTH = 134;
export const PLACEHOLDERS: readonly TemplatePlaceholder[] = TEMPLATE_PLACEHOLDERS;

// backend template.render.ts-тэй ижил дүрэм — хадгалахаас өмнө хэрэглэгчид шууд хэлнэ (эцсийн шалгалт сервер дээр).
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const ALLOWED = new Set<string>(TEMPLATE_PLACEHOLDERS);

export function extractPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** Зөвшөөрөгдөөгүй нэр + буруу хаалт (`{{ …` хаагдаагүй) байвал `{{…}}` гэж тэмдэглэнэ. */
export function findInvalidPlaceholders(...texts: Array<string | null | undefined>): string[] {
  const bad: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const name of extractPlaceholders(text)) if (!ALLOWED.has(name) && !bad.includes(name)) bad.push(name);
    if (/\{\{|\}\}/.test(text.replace(PLACEHOLDER_RE, '')) && !bad.includes('{{…}}')) bad.push('{{…}}');
  }
  return bad;
}

/** SMS: гарчиг хадгалахгүй. Бусад суваг (IN_APP, EMAIL, PUSH): гарчиг заавал. */
export const channelUsesSubject = (channel: NotificationChannel): boolean => channel !== 'SMS';

/** SMS-ийн сегмент (backend smsSegments-тай ижил): латин/GSM-7 → 160/153, бусад (кирилл) → UCS-2 70/67. */
export function smsSegments(text: string): { encoding: 'GSM7' | 'UCS2'; length: number; segments: number } {
  const length = [...text].length;
  const gsm = /^[\nA-Za-z0-9 @£$¥!"#¤%&'()*+,\-./:;<=>?¡§¿_]*$/.test(text);
  if (length === 0) return { encoding: gsm ? 'GSM7' : 'UCS2', length, segments: 0 };
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM7' : 'UCS2', length, segments: length <= single ? 1 : Math.ceil(length / multi) };
}

export interface TemplateTarget { type: NotificationType; channel: NotificationChannel; locale: string }
export interface TemplateFormValues { subject: string; body: string; isActive: boolean }

export const templateTarget = (t: TemplateView): TemplateTarget => ({ type: t.type, channel: t.channel, locale: t.locale });
export const templateRowKey = (t: TemplateTarget): string => `${t.type}|${t.channel}|${t.locale}`;
export const formFromTemplate = (t: TemplateView): TemplateFormValues => ({ subject: t.subject ?? '', body: t.body, isActive: t.isActive });

export function isTemplateDirty(initial: TemplateFormValues, current: TemplateFormValues): boolean {
  return initial.subject !== current.subject || initial.body !== current.body || initial.isActive !== current.isActive;
}

export type TemplateSource = 'BUILTIN' | 'OVERRIDE' | 'OVERRIDE_INACTIVE';
/** id=null — кодонд суулгасан анхдагч; id байвал админы override (идэвхгүй бол анхдагч руу буцна). */
export function templateSource(t: Pick<TemplateView, 'id' | 'isActive'>): TemplateSource {
  if (t.id === null) return 'BUILTIN';
  return t.isActive ? 'OVERRIDE' : 'OVERRIDE_INACTIVE';
}

export interface TemplateFilter { type?: NotificationType; channel?: NotificationChannel }
export function filterTemplates(list: readonly TemplateView[], f: TemplateFilter): TemplateView[] {
  return list.filter((t) => (!f.type || t.type === f.type) && (!f.channel || t.channel === f.channel));
}

/** Тухайн суваг дээр загвартай төрлүүд (NotificationType-ийн дарааллаар). Загвар ачаалагдаагүй бол зээлдэгчийн төрлүүд. */
export function typesForChannel(list: readonly TemplateView[] | undefined, channel: NotificationChannel): NotificationType[] {
  const present = new Set((list ?? []).filter((t) => t.channel === channel).map((t) => t.type));
  const types = NOTIFICATION_TYPES.filter((t) => present.has(t));
  return types.length > 0 ? types : channel === 'IN_APP' ? [...NOTIFICATION_TYPES] : [...CUSTOMER_TYPES];
}

export interface FieldError { field: 'subject' | 'body'; key: string; params?: Record<string, string | number> }

/** Хадгалахын өмнөх шалгалт: backend-ийн дүрэм (INVALID_PLACEHOLDER, SUBJECT_REQUIRED) + урт. */
export function validateTemplateForm(channel: NotificationChannel, v: TemplateFormValues): FieldError[] {
  const errors: FieldError[] = [];
  const uses = channelUsesSubject(channel);
  if (!v.body.trim()) errors.push({ field: 'body', key: 'notification.templates.error.bodyRequired' });
  else if (v.body.length > TEMPLATE_BODY_MAX) errors.push({ field: 'body', key: 'notification.templates.error.bodyTooLong', params: { max: TEMPLATE_BODY_MAX } });
  if (uses) {
    if (!v.subject.trim()) errors.push({ field: 'subject', key: 'notification.templates.error.subjectRequired' });
    else if (v.subject.length > TEMPLATE_SUBJECT_MAX) errors.push({ field: 'subject', key: 'notification.templates.error.subjectTooLong', params: { max: TEMPLATE_SUBJECT_MAX } });
  }
  const invalid = findInvalidPlaceholders(uses ? v.subject : null, v.body);
  if (invalid.length > 0) errors.push({ field: 'body', key: 'notification.templates.error.unknownPlaceholders', params: { names: invalid.join(', ') } });
  return errors;
}

export function buildUpsertRequest(target: TemplateTarget, v: TemplateFormValues): UpsertTemplateRequest {
  return {
    type: target.type,
    channel: target.channel,
    locale: target.locale,
    subject: channelUsesSubject(target.channel) ? v.subject.trim() : null,
    body: v.body.trim(),
    isActive: v.isActive,
  };
}

/** Урьдчилан харах хүсэлт. Агуулга хоосон/хэт урт эсвэл гарчиг хэт урт бол сервер 400 өгөх тул илгээхгүй (null). */
export function buildPreviewRequest(target: Pick<TemplateTarget, 'type' | 'channel'>, v: Pick<TemplateFormValues, 'subject' | 'body'>): PreviewTemplateRequest | null {
  if (!v.body.trim() || v.body.length > TEMPLATE_BODY_MAX || v.subject.length > TEMPLATE_SUBJECT_MAX) return null;
  return { type: target.type, channel: target.channel, subject: channelUsesSubject(target.channel) ? v.subject : null, body: v.body };
}

/** Placeholder-ийг курсорын байрлалд (сонголт байвал солиж) оруулна. `caret` — шинэ курсорын байрлал. */
export function insertPlaceholder(text: string, selStart: number, selEnd: number, name: TemplatePlaceholder): { text: string; caret: number } {
  const clamp = (n: number) => Math.min(Math.max(0, Number.isFinite(n) ? n : text.length), text.length);
  const a = clamp(selStart);
  const b = clamp(selEnd);
  const [start, end] = a <= b ? [a, b] : [b, a];
  const token = `{{${name}}}`;
  return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length };
}

// ── хүргэлтийн бүртгэл ───────────────────────────────────────────────────────────────
export interface DeliveryFilter { status?: DeliveryStatus; channel?: NotificationChannel; applicationId?: string; page: number; pageSize: number }

export function buildDeliveryQuery(f: DeliveryFilter): Record<string, string | number | undefined> {
  const q: DeliveryListQuery = { status: f.status, channel: f.channel, applicationId: f.applicationId?.trim() || undefined, page: f.page, pageSize: f.pageSize };
  return { ...q };
}

/** QUEUED боловч өмнө нь оролдсон — дахин оролдлого хүлээж байна. */
export const isRetrying = (d: Pick<DeliveryView, 'status' | 'attempts'>): boolean => d.status === 'QUEUED' && d.attempts > 0;

const DELIVERY_ERROR_CODES = new Set(['INVALID_ADDRESS', 'INVALID_TOKEN', 'PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'NOT_CONFIGURED', 'NOT_IMPLEMENTED']);
export const deliveryErrorKey = (code: string): string => `notification.deliveryError.${code}`;
/** Мэдэгдэж буй кодыг монголоор, үл мэдэгдэхийг эх хэлбэрээр. */
export function deliveryErrorLabel(code: string | null | undefined, tr: Translate): string | null {
  if (!code) return null;
  return DELIVERY_ERROR_CODES.has(code) ? tr(deliveryErrorKey(code)) : code;
}
export const DELIVERY_ERROR_KEYS: readonly string[] = [...DELIVERY_ERROR_CODES].map(deliveryErrorKey);

// ── туршилтын мессеж ─────────────────────────────────────────────────────────────────
// backend phone.ts-тэй ижил: "9911-2233", "+976 9911 2233", "00976…" → "+97699112233"; монгол гар утас 5–9-өөр эхэлсэн 8 орон.
export function normalizeMnPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\-.()]/g, '');
  if (s.startsWith('+976')) s = s.slice(4);
  else if (s.startsWith('00976')) s = s.slice(5);
  else if (s.startsWith('976') && s.length === 11) s = s.slice(3);
  return /^[5-9]\d{7}$/.test(s) ? `+976${s}` : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  return s && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

export type TestAddressResult = { ok: true; value: string } | { ok: false; key: string };

export function validateTestAddress(channel: CustomerChannel, raw: string): TestAddressResult {
  const value = raw.trim();
  if (!value) return { ok: false, key: 'notification.test.error.required' };
  if (channel === 'SMS') {
    const phone = normalizeMnPhone(value);
    return phone ? { ok: true, value: phone } : { ok: false, key: 'notification.test.error.invalidPhone' };
  }
  if (channel === 'EMAIL') {
    const email = normalizeEmail(value);
    return email ? { ok: true, value: email } : { ok: false, key: 'notification.test.error.invalidEmail' };
  }
  return value.length >= 8 ? { ok: true, value } : { ok: false, key: 'notification.test.error.invalidToken' };
}

export function buildTestRequest(channel: CustomerChannel, to: string, type: NotificationType): SendTestRequest {
  return { channel, to, type };
}

export interface TestOutcome { level: 'success' | 'info' | 'warning' | 'error'; message: string }

/** test-send-ийн хариу (боловсруулсны дараах хүргэлт) → хэрэглэгчид харуулах дүгнэлт. */
export function testSendOutcome(d: DeliveryView, tr: Translate): TestOutcome {
  const address = d.addressMasked ?? tr('notification.common.empty');
  const error = deliveryErrorLabel(d.lastError, tr) ?? tr('notification.common.empty');
  switch (d.status) {
    case 'SENT': return { level: 'success', message: tr('notification.test.outcome.sent', { address }) };
    case 'SKIPPED': return { level: 'warning', message: tr('notification.test.outcome.skipped', { error }) };
    case 'FAILED': return { level: 'error', message: tr('notification.test.outcome.failed', { error }) };
    default:
      return isRetrying(d)
        ? { level: 'warning', message: tr('notification.test.outcome.retry', { error, attempts: d.attempts }) }
        : { level: 'info', message: tr('notification.test.outcome.queued') };
  }
}

// ── төлөлтийн сануулга ───────────────────────────────────────────────────────────────
export interface RunForm { asOf: string; dryRun: boolean }

/** Огноо хоосон бол өнөөдөр (сервер шийднэ); бөглөсөн бол YYYY-MM-DD байх ёстой. Алдааны i18n түлхүүр эсвэл null. */
export function validateRunForm(f: RunForm): string | null {
  return f.asOf.trim() === '' || isValidIsoDate(f.asOf.trim()) ? null : 'notification.reminders.error.invalidDate';
}

export function buildRunRequest(f: RunForm): { asOf?: string; dryRun: boolean } {
  const asOf = f.asOf.trim();
  return asOf ? { asOf, dryRun: f.dryRun } : { dryRun: f.dryRun };
}

export interface ResultLine { key: string; label: string; value: string }

export function reminderResultLines(res: RunRemindersResponse, tr: Translate): ResultLine[] {
  return [
    { key: 'asOf', label: tr('notification.reminders.result.asOf'), value: res.asOf },
    { key: 'scanned', label: tr('notification.reminders.result.scanned'), value: String(res.scannedInstallments) },
    { key: 'scheduled', label: tr(res.dryRun ? 'notification.reminders.result.scheduledDry' : 'notification.reminders.result.scheduled'), value: String(res.scheduledDeliveries) },
    { key: 'duplicates', label: tr('notification.reminders.result.duplicates'), value: String(res.skippedDuplicates) },
  ];
}

// ── зээлдэгчийн сувгийн тохиргоо ─────────────────────────────────────────────────────
export type PreferenceDraft = Partial<Record<NotificationChannel, boolean>>;

export function draftFromView(view: NotificationPreferenceView): PreferenceDraft {
  return Object.fromEntries(view.channels.map((c) => [c.channel, c.enabled]));
}

/** Зөвхөн өөрчлөгдсөн сувгууд. Өөрчлөлт байхгүй бол null (хадгалах товчийг идэвхгүй болгоно). */
export function toPreferenceRequest(view: NotificationPreferenceView, draft: PreferenceDraft): NotificationPreferenceRequest | null {
  const channels = view.channels.flatMap((c) => {
    const next = draft[c.channel];
    return next !== undefined && next !== c.enabled ? [{ channel: c.channel, enabled: next }] : [];
  });
  return channels.length > 0 ? { channels } : null;
}

// ── алдаа ───────────────────────────────────────────────────────────────────────────
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOTIFICATION_NOT_FOUND', 'PUSH_DEVICE_NOT_FOUND', 'CUSTOMER_NOT_FOUND',
  'INVALID_PLACEHOLDER', 'SUBJECT_REQUIRED', 'INVALID_ADDRESS', 'CHANNEL_NOT_TESTABLE', 'TEMPLATE_NOT_FOUND', 'CHANNEL_NOT_APPLICABLE',
]);
/** Серверийн мессеж нь дэлгэрэнгүй мэдээлэлтэй (placeholder-ийн нэр, суваг) тул шууд харуулах кодууд. */
const SERVER_MESSAGE_CODES: ReadonlySet<string> = new Set(['INVALID_PLACEHOLDER', 'CHANNEL_NOT_APPLICABLE']);

export const errorKey = (code: string): string => `notification.error.${code}`;
/** i18n-д заавал байх алдааны түлхүүрүүд (тестэд ашиглана). */
export const ERROR_KEYS: readonly string[] = [...KNOWN_ERROR_CODES, 'SERVER', 'NETWORK', 'UNKNOWN'].map(errorKey);

export interface DescribedError { code: string | null; message: string; issues: string[] }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function describeError(error: unknown, tr: Translate): DescribedError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const status = typeof e.status === 'number' ? e.status : null;
  const serverMessage = str(e.message);

  if (code && SERVER_MESSAGE_CODES.has(code) && serverMessage) return { code, message: serverMessage, issues: [] };
  if (code && KNOWN_ERROR_CODES.has(code)) {
    const issues = code === 'VALIDATION_FAILED' && Array.isArray(e.issues)
      ? e.issues.flatMap((i: unknown) => {
          const issue = i as { path?: unknown; message?: unknown } | null;
          const text = str(issue?.message);
          if (!text) return [];
          const path = str(issue?.path);
          return [path ? `${path}: ${text}` : text];
        })
      : [];
    return { code, message: tr(errorKey(code)), issues };
  }
  const fallback = (key: string): DescribedError => ({ code, message: tr(errorKey(key)), issues: [] });
  if (status === 401) return fallback('UNAUTHENTICATED');
  if (status === 403) return fallback('FORBIDDEN');
  if (status !== null && status >= 500) return fallback('SERVER');
  if (error instanceof TypeError) return fallback('NETWORK'); // fetch холбогдож чадаагүй
  if (status !== null && serverMessage) return { code, message: serverMessage, issues: [] };
  return fallback('UNKNOWN');
}
