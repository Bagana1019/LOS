import { BsaUploadOutcome, type BsaUploadResponse } from '@los/contracts';
import { formatMnt } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { t } from '../../lib/i18n';
import { describeError } from '../borrowers/borrowers.utils';
import type { ResolveAction, ResolveImpact } from './bsa.resolve';

// BSA дэлгэцийн үр дүн, алдааны мэдээллийн цэвэр логик (I/O байхгүй): хуулга оруулах, төлбөр шинэчлэх, дохио шийдвэрлэх, импорт ажлын төлөв.

export type FeedbackType = 'success' | 'info' | 'warning' | 'error';
export interface Feedback { type: FeedbackType; message: string; details: string[] }

/**
 * scoring-ийн анхдагч хязгаар (`BSA_MAX_UPLOAD_BYTES` = 20 МБ, `BSA_MAX_FILES_PER_UPLOAD` = 10). Зөвхөн тайлбар текстэд; шалгалтыг сервер хийнэ,
 * тохиргоо өөрчлөгдсөн ч UI зөв файлыг хаахгүй.
 */
export const UPLOAD_LIMITS = { maxMb: 20, maxFiles: 10 } as const;
/** Сервер (`inspectFile`) PDF, зураг, CSV, текстийг л уншина; XLSX-г татгалздаг тул жагсаалтад оруулаагүй. */
export const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.csv,.txt';

// ── импорт ажлын төлөв (F6-6) ──────────────────────────────────────────────────────────

export type JobTagColor = 'default' | 'processing' | 'success' | 'error';
const JOB_COLOR: Readonly<Record<string, JobTagColor>> = { PENDING: 'default', PROCESSING: 'processing', COMPLETED: 'success', FAILED: 'error' };

/** Төлвийн Монгол шошго ба өнгө; мэдэгдэхгүй (шинэ) төлөв бол түүхий утгыг харуулна. */
export function jobStatusView(status: string): { label: string; color: JobTagColor } {
  const color = JOB_COLOR[status];
  return color ? { label: t(`bsa.fb.job.${status}`), color } : { label: status, color: 'default' };
}

// ── хуулга оруулах: алдаа (F6-4) ───────────────────────────────────────────────────────

/** Хуулга оруулах хүсэлтийн татгалзсан хариу: `code` ба файл бүрийн `outcomes` (серверийн `details`-д). */
export class UploadError extends ApiError {
  constructor(status: number, code: string | null, message: string, readonly outcomes: readonly BsaUploadOutcome[], correlationId: string | null) {
    super(status, code, message, undefined, correlationId);
    this.name = 'UploadError';
  }
}

/** Серверийн алдааны бие (`{ code, message, details: { outcomes } }`) → `UploadError`. JSON биш бол код/outcomes байхгүй, `statusText` технологийн мессеж. */
export function parseUploadFailure(status: number, statusText: string, body: unknown, correlationId: string | null): UploadError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; message?: unknown; details?: unknown };
  const details = (typeof b.details === 'object' && b.details !== null ? b.details : {}) as { outcomes?: unknown };
  const parsed = BsaUploadOutcome.array().safeParse(details.outcomes);
  const message = typeof b.message === 'string' && b.message ? b.message : statusText || `HTTP ${status}`;
  return new UploadError(status, typeof b.code === 'string' ? b.code : null, message, parsed.success ? parsed.data : [], correlationId);
}

// Алдааны код / HTTP статус → `bsa.fb.upload.err.<key>`. Код түрүүлнэ (нарийн), статус нь кодгүй (proxy, хуучин сервер) үед.
const CODE_KEYS: ReadonlyMap<string, string> = new Map([
  ['FILE_UNSUPPORTED', 'unsupported'], ['XLSX_UNSUPPORTED', 'xlsx'], ['FILE_EMPTY', 'empty'], ['FILE_TOO_LARGE', 'tooLarge'], ['TOO_MANY_FILES', 'tooMany'],
  ['INVALID_BANK', 'invalidBank'], ['ANALYSIS_NOT_DRAFT', 'notDraft'], ['NO_FILES', 'noFiles'], ['QUEUE_UNAVAILABLE', 'unavailable'],
  ['STORAGE_FAILED', 'server'], ['INTERNAL_ERROR', 'server'],
]);
const STATUS_KEYS: ReadonlyMap<number, string> = new Map([[413, 'tooLarge'], [415, 'unsupported'], [503, 'unavailable']]);

const reasonText = (key: string): string => t(`bsa.fb.upload.err.${key}`, { maxMb: UPLOAD_LIMITS.maxMb, max: UPLOAD_LIMITS.maxFiles });
const reasonKey = (code: string | null, status: number | null): string | undefined => (code ? CODE_KEYS.get(code) : undefined) ?? (status === null ? undefined : STATUS_KEYS.get(status));
const reasonOf = (code: string | null, status: number | null, fallback: string = reasonText('generic')): string => {
  const key = reasonKey(code, status);
  return key ? reasonText(key) : fallback;
};
const nameOf = (names: readonly string[], index: number): string => names[index] ?? t('bsa.fb.upload.fileN', { n: index + 1 });
const fileLine = (names: readonly string[], index: number, reason: string): string => t('bsa.fb.upload.fileLine', { name: nameOf(names, index), reason });

/** Нэвтрэлт, сервер, сүлжээний алдаа — хуулга оруулахад онцгой утгагүй тул нийтлэг Монгол мессежийг ашиглана. */
const isSharedFailure = (error: unknown, status: number | null): boolean =>
  error instanceof TypeError || (status !== null && (status === 0 || status === 401 || status === 403 || status >= 500));

/** Оруулалт бүхэлдээ алдаатай (нэг ч файл хүлээн аваагүй) үед: Монгол шалтгаан, олон файл бол файл бүрт нэг мөр. */
export function uploadErrorFeedback(error: unknown, names: readonly string[]): Feedback {
  const status = error instanceof ApiError ? error.status : null;
  const code = error instanceof ApiError ? error.code : null;
  if (error instanceof UploadError && error.outcomes.length > 1) {
    const lines = error.outcomes.flatMap((o) => (o.status === 'REJECTED' ? [fileLine(names, o.index, reasonOf(o.code, null, o.message))] : []));
    return { type: 'error', message: t('bsa.fb.upload.err.none'), details: lines };
  }
  const key = reasonKey(code, status);
  if (key) return { type: 'error', message: reasonText(key), details: [] };
  if (isSharedFailure(error, status)) return { type: 'error', message: describeError(error, t).message, details: [] };
  return { type: 'error', message: reasonText('generic'), details: [] };
}

// ── хуулга оруулах: үр дүн (F6-7) ──────────────────────────────────────────────────────

/** Хүсэлт амжилттай (200/202) ч файл бүр хүлээн авагдсан гэсэн үг биш: давхардсан, татгалзсаныг нэрээр нь хэлнэ. */
export function uploadFeedback(res: BsaUploadResponse, names: readonly string[]): Feedback {
  const parts = [
    res.accepted > 0 ? t('bsa.fb.upload.partAccepted', { count: res.accepted }) : null,
    res.duplicates > 0 ? t('bsa.fb.upload.partDuplicate', { count: res.duplicates }) : null,
    res.rejected > 0 ? t('bsa.fb.upload.partRejected', { count: res.rejected }) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return { type: 'info', message: t('bsa.fb.upload.none'), details: [] };

  const lines = res.outcomes.flatMap((o) => {
    if (o.status === 'DUPLICATE') return [t('bsa.fb.upload.dupLine', { name: nameOf(names, o.index) })];
    if (o.status === 'REJECTED') return [fileLine(names, o.index, reasonOf(o.code, null, o.message))];
    return [];
  });
  return {
    type: res.duplicates > 0 || res.rejected > 0 ? 'warning' : 'success',
    message: `${parts.join(', ')}.`,
    details: res.duplicates > 0 ? [...lines, t('bsa.fb.upload.dupHint')] : lines,
  };
}

// ── төлбөр шинэчлэх (F6-2) ─────────────────────────────────────────────────────────────

/** ЭТХ-ээс санал болгосон сарын төлбөр бүртгэгдээгүй (null) эсвэл 0 — `PushConfirmModal`-той ижил тодорхойлолт. */
export const isPaymentMissing = (payment: number | null): boolean => payment === null || payment <= 0;

/** `POST /bsa/sync-payment` нь `{ updated }` л буцаадаг (0 = шалтгаан тодорхойгүй) тул шалтгааныг тойм дахь төлбөр/шинжилгээнээс тодорхойлно. */
export function syncPaymentFeedback(o: { updated: number; payment: number | null; hasAnalysis: boolean }): Feedback {
  if (isPaymentMissing(o.payment)) return { type: 'warning', message: t('bsa.fb.sync.missing'), details: [] };
  if (!o.hasAnalysis) return { type: 'info', message: t('bsa.fb.sync.noAnalysis'), details: [] };
  if (o.updated > 0) return { type: 'success', message: t('bsa.fb.sync.updated', { count: o.updated }), details: [] };
  return { type: 'info', message: t('bsa.fb.sync.unchanged', { amount: formatMnt(o.payment ?? 0) }), details: [] };
}

// ── сэжигтэй дохио шийдвэрлэх (F6-12) ──────────────────────────────────────────────────

export interface ResolveFeedbackOptions {
  categoryName?: string | null;
  pendingFilter?: boolean;
  /** Сервер алгассан дохионы тоо (аль хэдийн шийдвэрлэгдсэн / олдоогүй). */
  skipped?: number;
  /** Хэдэн гүйлгээний ангилал солигдсон (F6-10); null = ангилал өөрчлөгддөггүй үйлдэл (зөвшөөрөх). */
  impact?: ResolveImpact | null;
}

/** Гүйлгээний ангилал хэд солигдсон, чиглэл таарахгүй тул хэд нь хэвээр үлдсэнийг хэлнэ (F6-10). */
function impactSentences(impact: ResolveImpact): string[] {
  const changed = impact.changed > 0 ? t('bsa.fb.resolve.txnChanged', { count: impact.changed }) : t('bsa.fb.resolve.txnNone');
  if (impact.unchanged === 0 || impact.unchangedDirection === null) return [changed];
  return [changed, t(`bsa.fb.resolve.txnUnchanged.${impact.unchangedDirection}`, { count: impact.unchanged })];
}

/**
 * Шийдвэрлэсний дараах мэдэгдэл: `count` = сервер шийдвэрлэсэн дохионы тоо. Алгассан дохио, ангилал солигдсон гүйлгээний тоог хэлнэ.
 * «Хүлээгдэж буй» шүүлтүүртэй үед мөр жагсаалтаас алга болдог тул шалтгааныг хамгийн сүүлд хэлнэ.
 */
export function resolveFeedback(action: ResolveAction, count: number, o: ResolveFeedbackOptions): string {
  const base = action === 'RECLASSIFY'
    ? (o.categoryName ? t('bsa.fb.resolve.RECLASSIFY', { count, category: o.categoryName }) : t('bsa.fb.resolve.RECLASSIFY.plain', { count }))
    : t(`bsa.fb.resolve.${action}`, { count });
  const skipped = o.skipped && o.skipped > 0 ? [t('bsa.fb.resolve.skipped', { count: o.skipped })] : [];
  const hint = o.pendingFilter ? [t('bsa.fb.resolve.filterHint')] : [];
  return [base, ...(o.impact ? impactSentences(o.impact) : []), ...skipped, ...hint].join(' ');
}
