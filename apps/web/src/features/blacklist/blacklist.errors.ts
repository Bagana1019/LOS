import { BLACKLIST_STALE } from '@los/contracts';
import { t } from '../../lib/i18n';
import { describeCustomerError } from '../customers/customer-error';
import { listTypeLabel } from './blacklist.utils';

// F8-4: API-ийн (англи) алдааг хар жагсаалтын маягтад монгол, талбар заасан мессеж болгоно. Зөвхөн энэ feature-д.

/** API-ийн body-ийн талбарын нэр (= маягтын талбар; `reason` = идэвхгүй болгох шалтгаан). */
export type BlacklistField = 'registerNo' | 'customerType' | 'name' | 'severity' | 'listType' | 'reasonCode' | 'reasonText' | 'source' | 'validUntil' | 'reason';
const FIELDS: readonly BlacklistField[] = ['registerNo', 'customerType', 'name', 'severity', 'listType', 'reasonCode', 'reasonText', 'source', 'validUntil', 'reason'];

export interface BlacklistFieldError { name: BlacklistField; message: string }
export interface DescribedBlacklistError {
  /** Маягтын дээд талын Alert-д харуулах нэг монгол өгүүлбэр. */
  message: string;
  /** Талбар бүрийн доор харуулах мессеж (хоосон байж болно). */
  fields: BlacklistFieldError[];
}
export interface BlacklistErrorContext { listType?: string }

interface Parts { status: number | null; code: string | null; message: string; issues: unknown[] }
interface RawIssue { code?: unknown; path?: unknown; message?: unknown }

const RE_DUPLICATE = /already exists/i;
const RE_PAST_DATE = /validUntil must be in the future/;
const RE_UNSAFE_TEXT = /\bNUL\b|U\+FFFD|lone surrogate/;
const RE_REGISTER_CHARS = /registerNo (contains unsupported characters|must contain letters or digits)/;
const RE_ENUM = /^Invalid enum value/;
const RE_MAX = /at most (\d+)/;
const RE_MIN = /at least \d+/;
const RE_CYRILLIC = /\p{Script=Cyrillic}/u;
const REGISTER_CODE_FIELD: Record<string, BlacklistField> = { INVALID_REGISTER_NO: 'registerNo', REGISTER_TYPE_MISMATCH: 'customerType' };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function partsOf(error: unknown): Parts {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  return {
    status: typeof e.status === 'number' ? e.status : null,
    code: typeof e.code === 'string' ? e.code : null,
    message: str(e.message),
    issues: Array.isArray(e.issues) ? e.issues : [],
  };
}

/** zod `path` нь массив (origination) эсвэл "a.b" мөр (gateway) байж болно; зөвхөн эхний сегмент. */
function fieldOf(path: unknown): BlacklistField | null {
  const head = Array.isArray(path) ? path[0] : typeof path === 'string' ? path.split(/[.[]/)[0] : undefined;
  return FIELDS.find((f) => f === head) ?? null;
}

function issueMessage(issue: RawIssue): string {
  const code = str(issue.code);
  const message = str(issue.message);
  if (RE_UNSAFE_TEXT.test(message)) return t('blacklist.error.unsafeText');
  if (RE_REGISTER_CHARS.test(message)) return t('blacklist.error.registerChars');
  if (message === 'Required') return t('blacklist.field.required');
  if (code === 'invalid_enum_value' || RE_ENUM.test(message)) return t('blacklist.error.enum');
  if (code === 'too_big' || RE_MAX.test(message)) {
    const max = RE_MAX.exec(message)?.[1];
    return max ? t('blacklist.error.tooLong', { max }) : t('blacklist.error.tooLongAny');
  }
  if (code === 'too_small' || RE_MIN.test(message)) return t('blacklist.error.tooShort');
  return t('blacklist.error.invalidField');
}

const rejected = (): DescribedBlacklistError => ({ message: t('blacklist.error.rejected'), fields: [] });
const withFields = (fields: BlacklistFieldError[]): DescribedBlacklistError => (fields.length > 0 ? { message: t('blacklist.error.formInvalid'), fields } : rejected());

/** Талбар бүрт эхний алдаа л үлдэнэ (дараалал хадгална). */
function fromIssues(p: Parts): DescribedBlacklistError | null {
  if (p.issues.length === 0) return null;
  const mapped = p.issues
    .map((raw) => (typeof raw === 'object' && raw !== null ? (raw as RawIssue) : {}))
    .flatMap((i) => { const name = fieldOf(i.path); return name ? [{ name, message: issueMessage(i) }] : []; });
  return withFields(mapped.filter((f, idx) => mapped.findIndex((g) => g.name === f.name) === idx));
}

function fromRegisterCode(p: Parts): DescribedBlacklistError | null {
  const name = p.code ? REGISTER_CODE_FIELD[p.code] : undefined;
  return name ? withFields([{ name, message: p.message || t('blacklist.error.invalidField') }]) : null;
}

function fromPastDate(p: Parts): DescribedBlacklistError | null {
  return p.status === 400 && RE_PAST_DATE.test(p.message) ? withFields([{ name: 'validUntil', message: t('blacklist.error.validUntilPast') }]) : null;
}

function fromConflict(p: Parts, ctx: BlacklistErrorContext): DescribedBlacklistError | null {
  if (p.status !== 409) return null;
  if (!RE_DUPLICATE.test(p.message)) return { message: t('blacklist.error.conflict'), fields: [] };
  const listType = ctx.listType ? listTypeLabel(ctx.listType) : '';
  return { message: t('blacklist.error.duplicate', { listType }), fields: [{ name: 'registerNo', message: t('blacklist.error.duplicate.field', { listType }) }] };
}

const isStale = (p: Parts): boolean => p.status === 409 && p.code === BLACKLIST_STALE;
/** F8-9: маягтын ачаалсан updatedAt хуучирсан (өөр tab/хэрэглэгч засчихсан) — сервер 409 + `BLACKLIST_STALE`. UI энэ үед «Шинэчлэх» үйлдэл харуулна. */
export const isStaleBlacklistError = (error: unknown): boolean => isStale(partsOf(error));
const fromStale = (p: Parts): DescribedBlacklistError | null => (isStale(p) ? { message: t('blacklist.error.stale'), fields: [] } : null);

/** customer-error-ийн 403 текст "харилцагч бүртгэх эрх" тул энд тохирохгүй; хар жагсаалтын эрхийн тайлбарыг ашиглана. */
const fromForbidden = (p: Parts): DescribedBlacklistError | null => (p.status === 403 ? { message: t('blacklist.readOnly'), fields: [] } : null);

/** Танигдаагүй 4xx: сервер монгол мессеж өгсөн бол тэр хэвээр, англи бол ерөнхий монгол текст. 401 нь хуваалцсан мессежээр. */
function fromUnmapped4xx(p: Parts): DescribedBlacklistError | null {
  if (p.status === null || p.status < 400 || p.status >= 500 || p.status === 401) return null;
  return RE_CYRILLIC.test(p.message) ? { message: p.message, fields: [] } : rejected();
}

/** `ctx.listType` — давхардлын мессежэд жагсаалтын нэрийг оруулах (маягтын утга). */
export function describeBlacklistError(error: unknown, ctx: BlacklistErrorContext = {}): DescribedBlacklistError {
  const p = partsOf(error);
  return fromIssues(p) ?? fromRegisterCode(p) ?? fromStale(p) ?? fromConflict(p, ctx) ?? fromPastDate(p) ?? fromForbidden(p) ?? fromUnmapped4xx(p) ?? { message: describeCustomerError(error).message, fields: [] };
}
